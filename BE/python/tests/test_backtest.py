from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

from python.backtest import BacktestError, load_csv, run_backtest


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / "python" / "backtest.py"
HEADER = "Date,Open,High,Low,Close,Volume\n"


def warning_codes(result: dict[str, object]) -> set[str]:
    warnings = result["warnings"]
    assert isinstance(warnings, list)
    return {
        warning.split("]", 1)[0].removeprefix("[")
        for warning in warnings
        if isinstance(warning, str) and warning.startswith("[") and "]" in warning
    }


class BacktestEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.created_files: list[Path] = []
        self.addCleanup(self.cleanup_files)

    def cleanup_files(self) -> None:
        for path in self.created_files:
            path.unlink(missing_ok=True)

    def fixture_path(self, name: str) -> Path:
        with tempfile.NamedTemporaryFile(
            prefix=f"{self._testMethodName}-",
            suffix=f"-{name}",
            delete=False,
        ) as temporary_file:
            path = Path(temporary_file.name)
        self.created_files.append(path)
        return path

    def write_csv(self, rows: str, name: str = "0050.csv", *, bom: bool = False) -> Path:
        path = self.fixture_path(name)
        encoding = "utf-8-sig" if bom else "utf-8"
        path.write_text(HEADER + rows, encoding=encoding, newline="")
        return path

    def test_signal_executes_at_next_open_with_whole_share_allocation(self) -> None:
        path = self.write_csv(
            "2024-01-01,10,11,9,10,100\n"
            "2024-01-02,11,13,10,12,100\n"
            "2024-01-03,20,21,17,18,100\n"
            "2024-01-04,9,10,7,8,100\n"
            "2024-01-05,7,8,6,7,100\n"
        )

        result = run_backtest(
            data=path,
            symbol="0050",
            cash=Decimal("100"),
            ma=2,
            allocation=Decimal("0.5"),
        )

        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["config"]["symbol"], "0050")
        self.assertEqual(result["config"]["shareSizing"], "WHOLE_SHARES")
        self.assertEqual(result["metrics"]["finalEquity"], 74.0)
        self.assertEqual(result["metrics"]["totalReturnPct"], -26.0)
        self.assertEqual(result["equityCurve"][1]["equity"], 100.0)
        self.assertEqual(result["equityCurve"][2]["positionShares"], 2)
        self.assertEqual(result["equityCurve"][2]["equity"], 96.0)

        self.assertEqual(len(result["trades"]), 1)
        trade = result["trades"][0]
        self.assertEqual(trade["status"], "CLOSED")
        self.assertEqual(trade["entrySignalDate"], "2024-01-02")
        self.assertEqual(trade["entryDate"], "2024-01-03")
        self.assertEqual(trade["entryPrice"], 20.0)
        self.assertEqual(trade["shares"], 2)
        self.assertEqual(trade["exitSignalDate"], "2024-01-04")
        self.assertEqual(trade["exitDate"], "2024-01-05")
        self.assertEqual(trade["netPnl"], -26.0)
        self.assertIn(
            "MAX_DRAWDOWN_THRESHOLD_REACHED",
            warning_codes(result),
        )

    def test_fee_and_slippage_are_applied_to_fill_and_budget(self) -> None:
        path = self.write_csv(
            "2024-01-01,10,11,9,10,100\n"
            "2024-01-02,11,13,10,12,100\n"
            "2024-01-03,10,11,9,10,100\n"
        )

        result = run_backtest(
            data=path,
            symbol="0050",
            cash=Decimal("1000"),
            ma=2,
            allocation=Decimal("0.5"),
            fee_rate=Decimal("0.01"),
            slippage_rate=Decimal("0.1"),
        )

        trade = result["trades"][0]
        self.assertEqual(trade["status"], "OPEN")
        self.assertEqual(trade["shares"], 45)
        self.assertEqual(trade["entryPrice"], 11.0)
        self.assertEqual(trade["entryGross"], 495.0)
        self.assertEqual(trade["entryFee"], 4.95)
        self.assertEqual(trade["entryCashOutflow"], 499.95)
        self.assertEqual(result["metrics"]["finalCash"], 500.05)
        self.assertEqual(result["metrics"]["finalMarketValue"], 450.0)
        self.assertEqual(result["metrics"]["finalEquity"], 950.05)
        self.assertEqual(result["metrics"]["totalFees"], 4.95)

    def test_end_position_is_marked_not_force_liquidated(self) -> None:
        path = self.write_csv(
            "2024-01-01,10,11,9,10,100\n"
            "2024-01-02,11,13,10,12,100\n"
            "2024-01-03,12,14,11,13,100\n"
        )

        result = run_backtest(data=path, symbol="0050", cash=Decimal("100"), ma=2)

        self.assertEqual(result["engine"]["endOfPeriodPolicy"], "MARK_TO_MARKET")
        self.assertEqual(result["trades"][0]["status"], "OPEN")
        self.assertEqual(result["trades"][0]["markDate"], "2024-01-03")
        self.assertEqual(result["trades"][0]["markPrice"], 13.0)
        self.assertIsNone(result["trades"][0]["exitDate"])
        self.assertIn(
            "OPEN_POSITION_MARKED_TO_MARKET",
            warning_codes(result),
        )

    def test_tiny_positive_trade_is_not_rounded_out_of_win_metrics(self) -> None:
        path = self.write_csv(
            "2024-01-01,1,1.1,0.9,1,100\n"
            "2024-01-02,1,2.1,0.9,2,100\n"
            "2024-01-03,1,2.1,0.9,2,100\n"
            "2024-01-04,1,1.1,0.4,0.5,100\n"
            "2024-01-05,1.00000004,1.1,0.4,0.5,100\n"
        )

        result = run_backtest(
            data=path,
            symbol="0050",
            cash=Decimal("10"),
            ma=2,
            allocation=Decimal("1"),
        )

        self.assertEqual(result["trades"][0]["netPnl"], 0.0000004)
        self.assertEqual(result["metrics"]["winningTrades"], 1)
        self.assertEqual(result["metrics"]["winRatePct"], 100.0)
        self.assertEqual(result["metrics"]["totalPnl"], 0.0000004)

    def test_final_sell_signal_remains_open_under_mark_to_market_policy(self) -> None:
        path = self.write_csv(
            "2024-01-01,10,11,9,10,100\n"
            "2024-01-02,11,13,10,12,100\n"
            "2024-01-03,11,14,10,13,100\n"
            "2024-01-04,6,7,4,5,100\n"
        )

        result = run_backtest(
            data=path,
            symbol="0050",
            cash=Decimal("100"),
            ma=2,
            allocation=Decimal("0.5"),
            max_drawdown_warning_pct=Decimal("100"),
        )

        self.assertEqual(result["trades"][0]["status"], "OPEN")
        self.assertIsNone(result["trades"][0]["exitDate"])
        self.assertEqual(result["trades"][0]["markDate"], "2024-01-04")
        self.assertTrue(
            {"UNEXECUTED_FINAL_SIGNAL", "OPEN_POSITION_MARKED_TO_MARKET"}.issubset(
                warning_codes(result)
            )
        )

    def test_range_is_inclusive_and_empty_range_fails(self) -> None:
        path = self.write_csv(
            "2024-01-01,10,11,9,10,100\n"
            "2024-01-02,11,12,10,11,100\n"
            "2024-01-03,12,13,11,12,100\n"
        )
        result = run_backtest(
            data=path,
            symbol="0050",
            from_date=date(2024, 1, 2),
            to_date=date(2024, 1, 3),
            ma=2,
        )
        self.assertEqual(result["data"]["rowsInRange"], 2)
        self.assertEqual(result["data"]["warmupRows"], 1)
        self.assertEqual(result["data"]["firstDate"], "2024-01-02")
        self.assertEqual(result["data"]["lastDate"], "2024-01-03")
        self.assertEqual(result["equityCurve"][0]["movingAverage"], 10.5)

        with self.assertRaisesRegex(BacktestError, "no rows"):
            run_backtest(
                data=path,
                symbol="0050",
                from_date=date(2025, 1, 1),
                to_date=date(2025, 1, 2),
                ma=2,
            )

    def test_bom_csv_and_metadata_are_preserved(self) -> None:
        path = self.write_csv(
            "2024-01-01,10,11,9,10,100\r\n"
            "2024-01-02,11,12,10,11,200\r\n",
            bom=True,
        )
        result = run_backtest(
            data=path,
            symbol="0050.TW",
            ma=2,
            data_source="vendor-a",
            data_version="2024-01-v2",
            adjustment="split-adjusted",
            volume_unit="shares",
        )

        self.assertEqual(result["data"]["source"], "vendor-a")
        self.assertEqual(result["data"]["version"], "2024-01-v2")
        self.assertEqual(result["data"]["adjustment"], "split-adjusted")
        self.assertEqual(result["data"]["volumeUnit"], "shares")
        self.assertEqual(result["data"]["fileName"], path.name)
        self.assertNotIn("path", result["data"])
        self.assertEqual(len(result["data"]["sha256"]), 64)

    def test_csv_rejects_missing_fields_bad_ohlc_and_nonascending_dates(self) -> None:
        cases = {
            "missing": "Date,Open,High,Low,Close\n2024-01-01,10,11,9,10\n",
            "bad_high": HEADER + "2024-01-01,10,9,8,10,100\n",
            "bad_low": HEADER + "2024-01-01,10,11,11,10,100\n",
            "negative_volume": HEADER + "2024-01-01,10,11,9,10,-1\n",
            "duplicate_date": (
                HEADER
                + "2024-01-01,10,11,9,10,100\n"
                + "2024-01-01,10,11,9,10,100\n"
            ),
            "bad_date": HEADER + "2024-02-30,10,11,9,10,100\n",
            "nan": HEADER + "2024-01-01,NaN,11,9,10,100\n",
        }

        for name, contents in cases.items():
            with self.subTest(name=name):
                path = self.fixture_path(f"{name}.csv")
                path.write_text(contents, encoding="utf-8", newline="")
                with self.assertRaises(BacktestError):
                    load_csv(path)

    def test_csv_normalizes_sub_penny_ohlc_serialization_noise(self) -> None:
        path = self.write_csv(
            "2024-01-01,15.446334431591442,15.578435897827147,"
            "15.446334431591442,15.578435897827148,100\n"
        )

        bars, _, _ = load_csv(path)

        self.assertEqual(bars[0].high, bars[0].close)
        self.assertEqual(bars[0].high, Decimal("15.578435897827148"))

    def test_invalid_parameters_are_rejected(self) -> None:
        path = self.write_csv("2024-01-01,10,11,9,10,100\n")
        invalid_overrides = (
            {"cash": Decimal("0")},
            {"ma": 1},
            {"allocation": Decimal("0")},
            {"allocation": Decimal("1.01")},
            {"fee_rate": Decimal("1")},
            {"slippage_rate": Decimal("-0.01")},
            {"max_drawdown_warning_pct": Decimal("101")},
            {"cash": Decimal("NaN")},
            {"from_date": date(2024, 2, 1), "to_date": date(2024, 1, 1)},
        )
        for override in invalid_overrides:
            with self.subTest(override=override), self.assertRaises(BacktestError):
                run_backtest(data=path, symbol="0050", **override)

    def test_cli_success_has_one_json_stdout_and_no_stderr(self) -> None:
        path = self.write_csv(
            "2024-01-01,10,11,9,10,100\n"
            "2024-01-02,11,13,10,12,100\n"
            "2024-01-03,12,14,11,13,100\n"
        )
        command = [
            sys.executable,
            str(SCRIPT_PATH),
            "--data",
            str(path),
            "--symbol",
            "0050",
            "--cash",
            "100000",
            "--ma",
            "2",
            "--allocation",
            "0.5",
            "--fee-rate",
            "0.001",
            "--slippage-rate",
            "0.0005",
            "--data-source",
            "test",
            "--data-version",
            "fixture-v1",
            "--adjustment",
            "none",
            "--volume-unit",
            "shares",
        ]

        first = subprocess.run(command, cwd=PROJECT_ROOT, text=True, capture_output=True)
        second = subprocess.run(command, cwd=PROJECT_ROOT, text=True, capture_output=True)

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stderr, "")
        self.assertEqual(first.stdout.count("\n"), 1)
        parsed = json.loads(first.stdout)
        self.assertEqual(parsed["symbol"], "0050")
        self.assertEqual(parsed["config"]["symbol"], "0050")
        self.assertEqual(parsed["strategy"]["key"], "ma-trend")
        self.assertTrue(all(isinstance(warning, str) for warning in parsed["warnings"]))
        self.assertEqual(parsed["schemaVersion"], 1)
        self.assertEqual(first.stdout, second.stdout)

    def test_cli_failure_keeps_stdout_empty_and_uses_nonzero_exit(self) -> None:
        path = self.write_csv("2024-01-01,10,9,8,10,100\n")

        completed = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), "--data", str(path), "--ma", "2"],
            cwd=PROJECT_ROOT,
            text=True,
            capture_output=True,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")
        self.assertIn("backtest input error", completed.stderr)


if __name__ == "__main__":
    unittest.main()

