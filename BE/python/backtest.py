#!/usr/bin/env python3
"""Command-line entry point for the reproducible MA trend backtest.

Successful runs write exactly one JSON document to stdout.  Diagnostics and
validation errors are written only to stderr, which keeps this program safe to
invoke through Node.js ``child_process.spawn``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import sys
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_FLOOR
from pathlib import Path
from typing import Any, Sequence

try:  # Package import in tests and direct script execution both need to work.
    from .strategies.ma_trend import (
        STRATEGY_NAME,
        STRATEGY_VERSION,
        signal_at_close,
        simple_moving_average,
    )
except ImportError:  # pragma: no cover - exercised by CLI subprocess tests
    from strategies.ma_trend import (  # type: ignore[no-redef]
        STRATEGY_NAME,
        STRATEGY_VERSION,
        signal_at_close,
        simple_moving_average,
    )


SCHEMA_VERSION = 1
ENGINE_NAME = "stdlib-ma-backtester"
ENGINE_VERSION = "1.0.0"
END_OF_PERIOD_POLICY = "MARK_TO_MARKET"
REQUIRED_COLUMNS = ("Date", "Open", "High", "Low", "Close", "Volume")
ISO_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
OHLC_RELATIVE_TOLERANCE = Decimal("1e-12")


class BacktestError(ValueError):
    """A user-facing input or data-validation failure."""


@dataclass(frozen=True)
class Bar:
    trading_date: date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    line_number: int


@dataclass(frozen=True)
class BacktestConfig:
    symbol: str
    initial_cash: Decimal
    ma_period: int
    allocation: Decimal
    fee_rate: Decimal
    slippage_rate: Decimal
    max_drawdown_warning_pct: Decimal
    requested_from: date | None
    requested_to: date | None


@dataclass
class Position:
    trade_id: int
    shares: int
    entry_signal_date: date
    entry_date: date
    entry_index: int
    entry_price: Decimal
    entry_gross: Decimal
    entry_fee: Decimal

    @property
    def cash_outflow(self) -> Decimal:
        return self.entry_gross + self.entry_fee


def _parse_iso_date(raw: str, field_name: str) -> date:
    if not ISO_DATE_PATTERN.fullmatch(raw):
        raise BacktestError(f"{field_name} must use YYYY-MM-DD format; received {raw!r}")
    try:
        parsed = date.fromisoformat(raw)
    except ValueError as error:
        raise BacktestError(f"{field_name} is not a valid calendar date: {raw!r}") from error
    if parsed.isoformat() != raw:
        raise BacktestError(f"{field_name} must use YYYY-MM-DD format; received {raw!r}")
    return parsed


def _parse_decimal(raw: str, field_name: str) -> Decimal:
    if raw is None or raw.strip() == "":
        raise BacktestError(f"{field_name} must not be empty")
    try:
        value = Decimal(raw.strip())
    except InvalidOperation as error:
        raise BacktestError(f"{field_name} must be numeric; received {raw!r}") from error
    if not value.is_finite():
        raise BacktestError(f"{field_name} must be finite; received {raw!r}")
    return value


def _validate_text(value: str, field_name: str, max_length: int = 200) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise BacktestError(f"{field_name} must be a non-empty value without outer whitespace")
    if len(value) > max_length or any(ord(character) < 32 for character in value):
        raise BacktestError(f"{field_name} contains unsupported characters or is too long")
    return value


def _decimal_arg(raw: str) -> Decimal:
    try:
        return _parse_decimal(raw, "argument")
    except BacktestError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def _date_arg(raw: str) -> date:
    try:
        return _parse_iso_date(raw, "date argument")
    except BacktestError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def _positive_int_arg(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if str(value) != raw.strip() or value < 2:
        raise argparse.ArgumentTypeError("must be an integer greater than or equal to 2")
    return value


def _validate_config(config: BacktestConfig) -> None:
    _validate_text(config.symbol, "symbol", max_length=64)
    for field_name, value in (
        ("cash", config.initial_cash),
        ("allocation", config.allocation),
        ("fee-rate", config.fee_rate),
        ("slippage-rate", config.slippage_rate),
        ("max-drawdown-warning-pct", config.max_drawdown_warning_pct),
    ):
        if not isinstance(value, Decimal) or not value.is_finite():
            raise BacktestError(f"{field_name} must be a finite decimal number")
    if config.initial_cash <= 0:
        raise BacktestError("cash must be greater than 0")
    if (
        isinstance(config.ma_period, bool)
        or not isinstance(config.ma_period, int)
        or config.ma_period < 2
    ):
        raise BacktestError("ma must be an integer greater than or equal to 2")
    if config.allocation <= 0 or config.allocation > 1:
        raise BacktestError("allocation must be greater than 0 and no greater than 1")
    if config.fee_rate < 0 or config.fee_rate >= 1:
        raise BacktestError("fee-rate must be at least 0 and less than 1")
    if config.slippage_rate < 0 or config.slippage_rate >= 1:
        raise BacktestError("slippage-rate must be at least 0 and less than 1")
    if config.max_drawdown_warning_pct < 0 or config.max_drawdown_warning_pct > 100:
        raise BacktestError("max-drawdown-warning-pct must be at least 0 and at most 100")
    if (
        config.requested_from is not None
        and config.requested_to is not None
        and config.requested_from > config.requested_to
    ):
        raise BacktestError("from must be earlier than or equal to to")


def load_csv(path_value: str | Path) -> tuple[list[Bar], Path, str]:
    """Load and strictly validate an ascending daily OHLCV CSV."""

    path = Path(path_value).expanduser()
    try:
        resolved_path = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise BacktestError(f"data file does not exist or cannot be resolved: {path}") from error
    if not resolved_path.is_file():
        raise BacktestError(f"data path is not a regular file: {path}")

    try:
        raw_csv = resolved_path.read_bytes()
    except OSError as error:
        raise BacktestError(f"cannot read data file {path}: {error}") from error
    sha256 = hashlib.sha256(raw_csv).hexdigest()
    try:
        csv_text = raw_csv.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise BacktestError("CSV must be UTF-8 encoded") from error

    bars: list[Bar] = []
    try:
        with io.StringIO(csv_text, newline="") as csv_file:
            reader = csv.DictReader(csv_file, strict=True)
            if reader.fieldnames is None:
                raise BacktestError("CSV is empty or has no header row")
            if len(reader.fieldnames) != len(set(reader.fieldnames)):
                raise BacktestError("CSV header contains duplicate column names")
            missing = [column for column in REQUIRED_COLUMNS if column not in reader.fieldnames]
            if missing:
                raise BacktestError(f"CSV is missing required columns: {', '.join(missing)}")

            previous_date: date | None = None
            for row in reader:
                line_number = reader.line_num
                if None in row or any(row.get(column) is None for column in reader.fieldnames):
                    raise BacktestError(
                        f"CSV row ending at line {line_number} has the wrong number of fields"
                    )

                raw_date = row["Date"]
                trading_date = _parse_iso_date(raw_date, f"CSV line {line_number} Date")
                open_price = _parse_decimal(row["Open"], f"CSV line {line_number} Open")
                high = _parse_decimal(row["High"], f"CSV line {line_number} High")
                low = _parse_decimal(row["Low"], f"CSV line {line_number} Low")
                close = _parse_decimal(row["Close"], f"CSV line {line_number} Close")
                volume = _parse_decimal(row["Volume"], f"CSV line {line_number} Volume")

                for column, value in (
                    ("Open", open_price),
                    ("High", high),
                    ("Low", low),
                    ("Close", close),
                ):
                    if value <= 0:
                        raise BacktestError(
                            f"CSV line {line_number} {column} must be greater than 0"
                        )
                if volume < 0:
                    raise BacktestError(f"CSV line {line_number} Volume must not be negative")
                upper_bound = max(open_price, close)
                lower_bound = min(open_price, close)
                tolerance = max(open_price, high, low, close) * OHLC_RELATIVE_TOLERANCE
                if high < upper_bound:
                    if upper_bound - high > tolerance:
                        raise BacktestError(
                            f"CSV line {line_number} High is below Open or Close"
                        )
                    high = upper_bound
                if low > lower_bound:
                    if low - lower_bound > tolerance:
                        raise BacktestError(
                            f"CSV line {line_number} Low is above Open or Close"
                        )
                    low = lower_bound
                if previous_date is not None and trading_date <= previous_date:
                    raise BacktestError(
                        f"CSV dates must be strictly ascending and unique; line {line_number} "
                        f"contains {trading_date.isoformat()}"
                    )

                bars.append(
                    Bar(
                        trading_date=trading_date,
                        open=open_price,
                        high=high,
                        low=low,
                        close=close,
                        volume=volume,
                        line_number=line_number,
                    )
                )
                previous_date = trading_date
    except csv.Error as error:
        raise BacktestError(f"invalid CSV near line {error}") from error

    if not bars:
        raise BacktestError("CSV contains no data rows")
    return bars, resolved_path, sha256


def _number(value: Decimal) -> float:
    """Convert a finite Decimal to a JSON-safe number without fixed-place rounding."""

    number = float(value)
    if not math.isfinite(number):
        raise BacktestError("a calculated number is outside the JSON numeric range")
    return 0.0 if number == 0 else number


def _percentage(numerator: Decimal, denominator: Decimal) -> Decimal | None:
    if denominator == 0:
        return None
    return numerator / denominator * Decimal("100")


def _warning(code: str, message: str) -> str:
    return f"[{code}] {message}"


def _closed_trade(
    position: Position,
    *,
    exit_signal_date: date,
    exit_date: date,
    exit_index: int,
    exit_price: Decimal,
    exit_fee: Decimal,
) -> dict[str, Any]:
    exit_gross = exit_price * position.shares
    cash_inflow = exit_gross - exit_fee
    gross_pnl = exit_gross - position.entry_gross
    net_pnl = cash_inflow - position.cash_outflow
    return_pct = _percentage(net_pnl, position.cash_outflow)
    return {
        "tradeId": position.trade_id,
        "status": "CLOSED",
        "shares": position.shares,
        "entrySignalDate": position.entry_signal_date.isoformat(),
        "entryDate": position.entry_date.isoformat(),
        "entryPrice": _number(position.entry_price),
        "entryGross": _number(position.entry_gross),
        "entryFee": _number(position.entry_fee),
        "entryCashOutflow": _number(position.cash_outflow),
        "exitSignalDate": exit_signal_date.isoformat(),
        "exitDate": exit_date.isoformat(),
        "exitPrice": _number(exit_price),
        "exitGross": _number(exit_gross),
        "exitFee": _number(exit_fee),
        "exitCashInflow": _number(cash_inflow),
        "grossPnl": _number(gross_pnl),
        "netPnl": _number(net_pnl),
        "returnPct": _number(return_pct) if return_pct is not None else None,
        "holdingTradingDays": exit_index - position.entry_index,
        "holdingCalendarDays": (exit_date - position.entry_date).days,
        "exitReason": "STRATEGY_SIGNAL",
        "markDate": None,
        "markPrice": None,
        "unrealizedPnl": None,
        "unrealizedReturnPct": None,
    }


def _open_trade(position: Position, last_bar: Bar) -> dict[str, Any]:
    market_value = last_bar.close * position.shares
    unrealized_pnl = market_value - position.cash_outflow
    unrealized_return = _percentage(unrealized_pnl, position.cash_outflow)
    return {
        "tradeId": position.trade_id,
        "status": "OPEN",
        "shares": position.shares,
        "entrySignalDate": position.entry_signal_date.isoformat(),
        "entryDate": position.entry_date.isoformat(),
        "entryPrice": _number(position.entry_price),
        "entryGross": _number(position.entry_gross),
        "entryFee": _number(position.entry_fee),
        "entryCashOutflow": _number(position.cash_outflow),
        "exitSignalDate": None,
        "exitDate": None,
        "exitPrice": None,
        "exitGross": None,
        "exitFee": None,
        "exitCashInflow": None,
        "grossPnl": None,
        "netPnl": None,
        "returnPct": None,
        "holdingTradingDays": None,
        "holdingCalendarDays": None,
        "exitReason": None,
        "markDate": last_bar.trading_date.isoformat(),
        "markPrice": _number(last_bar.close),
        "unrealizedPnl": _number(unrealized_pnl),
        "unrealizedReturnPct": (
            _number(unrealized_return) if unrealized_return is not None else None
        ),
    }


def _annualized_return_pct(
    initial_cash: Decimal, final_equity: Decimal, first_date: date, last_date: date
) -> float | None:
    elapsed_days = (last_date - first_date).days
    if elapsed_days <= 0 or final_equity <= 0:
        return None
    try:
        annualized = (
            math.pow(float(final_equity / initial_cash), 365.25 / elapsed_days) - 1
        ) * 100
    except (OverflowError, ValueError):
        return None
    return round(annualized, 6) if math.isfinite(annualized) else None


def _metrics(
    *,
    config: BacktestConfig,
    bars: Sequence[Bar],
    equity_values: Sequence[Decimal],
    closed_trades: Sequence[dict[str, Any]],
    closed_trade_net_pnls: Sequence[Decimal],
    position: Position | None,
    cash: Decimal,
    total_fees: Decimal,
    max_drawdown_pct: Decimal,
    bars_in_market: int,
) -> dict[str, Any]:
    final_market_value = bars[-1].close * position.shares if position is not None else Decimal(0)
    final_equity = cash + final_market_value
    total_pnl = final_equity - config.initial_cash
    unrealized_pnl = (
        final_market_value - position.cash_outflow if position is not None else Decimal(0)
    )
    # With a single long-only position, this identity avoids deriving metrics
    # from the rounded JSON representation of individual closed trades.
    realized_pnl = total_pnl - unrealized_pnl
    wins = [net_pnl for net_pnl in closed_trade_net_pnls if net_pnl > 0]
    losses = [net_pnl for net_pnl in closed_trade_net_pnls if net_pnl < 0]
    gross_profit = sum(wins, Decimal(0))
    gross_loss = -sum(losses, Decimal(0))
    win_rate = _percentage(Decimal(len(wins)), Decimal(len(closed_trade_net_pnls)))
    exposure = _percentage(Decimal(bars_in_market), Decimal(len(bars)))
    total_return = _percentage(total_pnl, config.initial_cash)

    return {
        "initialCash": _number(config.initial_cash),
        "finalCash": _number(cash),
        "finalMarketValue": _number(final_market_value),
        "finalEquity": _number(final_equity),
        "totalPnl": _number(total_pnl),
        "realizedPnl": _number(realized_pnl),
        "unrealizedPnl": _number(unrealized_pnl),
        "totalReturnPct": _number(total_return) if total_return is not None else None,
        "annualizedReturnPct": _annualized_return_pct(
            config.initial_cash, final_equity, bars[0].trading_date, bars[-1].trading_date
        ),
        "maxDrawdownPct": _number(max_drawdown_pct),
        "totalFees": _number(total_fees),
        "totalTrades": len(closed_trades) + (1 if position is not None else 0),
        "closedTrades": len(closed_trades),
        "openTrades": 1 if position is not None else 0,
        "winningTrades": len(wins),
        "losingTrades": len(losses),
        "winRatePct": _number(win_rate) if win_rate is not None else None,
        "profitFactor": _number(gross_profit / gross_loss) if gross_loss > 0 else None,
        "exposurePct": _number(exposure) if exposure is not None else 0.0,
        "equityPoints": len(equity_values),
    }


def _run_engine(
    bars: Sequence[Bar], config: BacktestConfig, trading_start_index: int
) -> tuple[dict[str, Any], list[str]]:
    if trading_start_index < 0 or trading_start_index >= len(bars):
        raise BacktestError("trading start index is outside the available data")
    trading_bars = bars[trading_start_index:]
    moving_averages = simple_moving_average(
        [bar.close for bar in bars], config.ma_period
    )
    cash = config.initial_cash
    position: Position | None = None
    pending: tuple[str, date] | None = None
    next_trade_id = 1
    closed_trades: list[dict[str, Any]] = []
    closed_trade_net_pnls: list[Decimal] = []
    equity_curve: list[dict[str, Any]] = []
    equity_values: list[Decimal] = []
    warnings: list[str] = []
    total_fees = Decimal(0)
    peak_equity = config.initial_cash
    max_drawdown_pct = Decimal(0)
    bars_in_market = 0
    insufficient_budget_count = 0

    for index in range(trading_start_index, len(bars)):
        bar = bars[index]
        moving_average = moving_averages[index]
        trading_index = index - trading_start_index
        if pending is not None:
            action, signal_date = pending
            if action == "BUY" and position is None:
                fill_price = bar.open * (Decimal(1) + config.slippage_rate)
                per_share_outflow = fill_price * (Decimal(1) + config.fee_rate)
                budget = cash * config.allocation
                shares = int(
                    (budget / per_share_outflow).to_integral_value(rounding=ROUND_FLOOR)
                )
                if shares >= 1:
                    entry_gross = fill_price * shares
                    entry_fee = entry_gross * config.fee_rate
                    cash -= entry_gross + entry_fee
                    total_fees += entry_fee
                    position = Position(
                        trade_id=next_trade_id,
                        shares=shares,
                        entry_signal_date=signal_date,
                        entry_date=bar.trading_date,
                        entry_index=trading_index,
                        entry_price=fill_price,
                        entry_gross=entry_gross,
                        entry_fee=entry_fee,
                    )
                    next_trade_id += 1
                else:
                    insufficient_budget_count += 1
            elif action == "SELL" and position is not None:
                fill_price = bar.open * (Decimal(1) - config.slippage_rate)
                exit_gross = fill_price * position.shares
                exit_fee = exit_gross * config.fee_rate
                cash += exit_gross - exit_fee
                total_fees += exit_fee
                closed_trade_net_pnls.append(
                    exit_gross - exit_fee - position.cash_outflow
                )
                closed_trades.append(
                    _closed_trade(
                        position,
                        exit_signal_date=signal_date,
                        exit_date=bar.trading_date,
                        exit_index=trading_index,
                        exit_price=fill_price,
                        exit_fee=exit_fee,
                    )
                )
                position = None
            pending = None

        market_value = bar.close * position.shares if position is not None else Decimal(0)
        equity = cash + market_value
        if equity > peak_equity:
            peak_equity = equity
        drawdown_pct = (
            (peak_equity - equity) / peak_equity * Decimal("100")
            if peak_equity > 0
            else Decimal(0)
        )
        max_drawdown_pct = max(max_drawdown_pct, drawdown_pct)
        if position is not None:
            bars_in_market += 1

        equity_values.append(equity)
        equity_curve.append(
            {
                "date": bar.trading_date.isoformat(),
                "cash": _number(cash),
                "marketValue": _number(market_value),
                "equity": _number(equity),
                "positionShares": position.shares if position is not None else 0,
                "close": _number(bar.close),
                "movingAverage": (
                    _number(moving_average) if moving_average is not None else None
                ),
                "drawdownPct": _number(drawdown_pct),
            }
        )

        signal = signal_at_close(
            currently_long=position is not None,
            close=bar.close,
            moving_average=moving_average,
        )
        if signal != "HOLD":
            pending = (signal, bar.trading_date)

    if not any(
        moving_average is not None
        for moving_average in moving_averages[trading_start_index:]
    ):
        warnings.append(
            _warning(
                "INSUFFICIENT_MA_HISTORY",
                f"MA({config.ma_period}) never becomes available during the requested range.",
            )
        )
    elif trading_start_index < config.ma_period - 1:
        warnings.append(
            _warning(
                "PARTIAL_MA_WARMUP",
                f"Only {trading_start_index} pre-range row(s) are available; the first requested bars have no MA({config.ma_period}).",
            )
        )
    if insufficient_budget_count:
        warnings.append(
            _warning(
                "INSUFFICIENT_WHOLE_SHARE_BUDGET",
                f"{insufficient_budget_count} buy signal(s) could not afford one whole share within allocation.",
            )
        )
    if pending is not None:
        warnings.append(
            _warning(
                "UNEXECUTED_FINAL_SIGNAL",
                f"A {pending[0]} signal confirmed on {pending[1].isoformat()} has no next trading day in range.",
            )
        )
    if position is not None:
        warnings.append(
            _warning(
                "OPEN_POSITION_MARKED_TO_MARKET",
                "The final open position is valued at the last Close without exit fee or sell slippage; it is not force-liquidated.",
            )
        )

    metrics = _metrics(
        config=config,
        bars=trading_bars,
        equity_values=equity_values,
        closed_trades=closed_trades,
        closed_trade_net_pnls=closed_trade_net_pnls,
        position=position,
        cash=cash,
        total_fees=total_fees,
        max_drawdown_pct=max_drawdown_pct,
        bars_in_market=bars_in_market,
    )
    if max_drawdown_pct > 0 and max_drawdown_pct >= config.max_drawdown_warning_pct:
        warnings.append(
            _warning(
                "MAX_DRAWDOWN_THRESHOLD_REACHED",
                "Observed max drawdown "
                f"{metrics['maxDrawdownPct']}% reached the evaluation threshold "
                f"{_number(config.max_drawdown_warning_pct)}%; this warning does not stop trading.",
            )
        )

    trades = list(closed_trades)
    if position is not None:
        trades.append(_open_trade(position, bars[-1]))
    return {"metrics": metrics, "equityCurve": equity_curve, "trades": trades}, warnings


def run_backtest(
    *,
    data: str | Path,
    symbol: str | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
    cash: Decimal = Decimal("100000"),
    ma: int = 60,
    allocation: Decimal = Decimal("0.5"),
    fee_rate: Decimal = Decimal("0"),
    slippage_rate: Decimal = Decimal("0"),
    max_drawdown_warning_pct: Decimal = Decimal("20"),
    data_source: str = "local-csv",
    data_version: str | None = None,
    adjustment: str = "unspecified",
    volume_unit: str = "unspecified",
) -> dict[str, Any]:
    """Validate inputs, execute the backtest, and return the versioned result."""

    bars, resolved_path, sha256 = load_csv(data)
    selected_symbol = symbol if symbol is not None else Path(data).stem
    config = BacktestConfig(
        symbol=selected_symbol,
        initial_cash=cash,
        ma_period=ma,
        allocation=allocation,
        fee_rate=fee_rate,
        slippage_rate=slippage_rate,
        max_drawdown_warning_pct=max_drawdown_warning_pct,
        requested_from=from_date,
        requested_to=to_date,
    )
    _validate_config(config)
    source = _validate_text(data_source, "data-source")
    version = (
        _validate_text(data_version, "data-version")
        if data_version is not None
        else f"sha256:{sha256}"
    )
    adjustment_value = _validate_text(adjustment, "adjustment")
    volume_unit_value = _validate_text(volume_unit, "volume-unit")

    bars_through_end = [
        bar for bar in bars if to_date is None or bar.trading_date <= to_date
    ]
    trading_start_index = next(
        (
            index
            for index, bar in enumerate(bars_through_end)
            if from_date is None or bar.trading_date >= from_date
        ),
        -1,
    )
    if trading_start_index == -1:
        requested_range = (
            f"{from_date.isoformat() if from_date else '-infinity'} to "
            f"{to_date.isoformat() if to_date else '+infinity'}"
        )
        raise BacktestError(f"CSV has no rows in requested range {requested_range}")
    selected_bars = bars_through_end[trading_start_index:]

    engine_result, warnings = _run_engine(
        bars_through_end, config, trading_start_index
    )
    if from_date is not None and from_date < bars[0].trading_date:
        warnings.insert(
            0,
            _warning(
                "REQUESTED_FROM_BEFORE_DATA",
                f"Requested from {from_date.isoformat()} precedes first CSV row {bars[0].trading_date.isoformat()}.",
            ),
        )
    if to_date is not None and to_date > bars[-1].trading_date:
        warnings.insert(
            0,
            _warning(
                "REQUESTED_TO_AFTER_DATA",
                f"Requested to {to_date.isoformat()} exceeds last CSV row {bars[-1].trading_date.isoformat()}.",
            ),
        )

    return {
        "schemaVersion": SCHEMA_VERSION,
        "symbol": config.symbol,
        "engine": {
            "name": ENGINE_NAME,
            "version": ENGINE_VERSION,
            "language": "python",
            "pythonVersion": sys.version.split()[0],
            "endOfPeriodPolicy": END_OF_PERIOD_POLICY,
        },
        "strategy": {
            "key": STRATEGY_NAME,
            "name": STRATEGY_NAME,
            "version": STRATEGY_VERSION,
            "params": {"maPeriod": config.ma_period},
            "description": "Close above MA targets long; Close below MA targets flat; execute next Open.",
        },
        "config": {
            "symbol": config.symbol,
            "from": (
                config.requested_from.isoformat()
                if config.requested_from is not None
                else selected_bars[0].trading_date.isoformat()
            ),
            "to": (
                config.requested_to.isoformat()
                if config.requested_to is not None
                else selected_bars[-1].trading_date.isoformat()
            ),
            "initialCash": _number(config.initial_cash),
            "maPeriod": config.ma_period,
            "allocation": _number(config.allocation),
            "feeRate": _number(config.fee_rate),
            "slippageRate": _number(config.slippage_rate),
            "maxDrawdownWarningPct": _number(config.max_drawdown_warning_pct),
            "signalTiming": "CLOSE",
            "executionTiming": "NEXT_TRADING_DAY_OPEN",
            "shareSizing": "WHOLE_SHARES",
            "endOfPeriodPolicy": END_OF_PERIOD_POLICY,
        },
        "data": {
            "fileName": resolved_path.name,
            "symbol": config.symbol,
            "source": source,
            "version": version,
            "sha256": sha256,
            "adjustment": adjustment_value,
            "volumeUnit": volume_unit_value,
            "rowsInFile": len(bars),
            "rowsInRange": len(selected_bars),
            "warmupRows": trading_start_index,
            "fileFirstDate": bars[0].trading_date.isoformat(),
            "fileLastDate": bars[-1].trading_date.isoformat(),
            "firstDate": selected_bars[0].trading_date.isoformat(),
            "lastDate": selected_bars[-1].trading_date.isoformat(),
        },
        "metrics": engine_result["metrics"],
        "equityCurve": engine_result["equityCurve"],
        "trades": engine_result["trades"],
        "warnings": warnings,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the MA trend daily-bar backtest")
    parser.add_argument("--data", required=True, help="UTF-8 OHLCV CSV path")
    parser.add_argument("--symbol", help="instrument identifier (defaults to CSV stem)")
    parser.add_argument("--from", dest="from_date", type=_date_arg, help="inclusive YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", type=_date_arg, help="inclusive YYYY-MM-DD")
    parser.add_argument("--cash", type=_decimal_arg, default=Decimal("100000"))
    parser.add_argument("--ma", type=_positive_int_arg, default=60)
    parser.add_argument("--allocation", type=_decimal_arg, default=Decimal("0.5"))
    parser.add_argument("--fee-rate", type=_decimal_arg, default=Decimal("0"))
    parser.add_argument("--slippage-rate", type=_decimal_arg, default=Decimal("0"))
    parser.add_argument(
        "--max-drawdown-warning-pct", type=_decimal_arg, default=Decimal("20")
    )
    parser.add_argument("--data-source", default="local-csv")
    parser.add_argument("--data-version")
    parser.add_argument("--adjustment", default="unspecified")
    parser.add_argument("--volume-unit", default="unspecified")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    # Pipes on Windows may otherwise inherit a legacy console encoding.  Node
    # always decodes this protocol as UTF-8.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = run_backtest(
            data=args.data,
            symbol=args.symbol,
            from_date=args.from_date,
            to_date=args.to_date,
            cash=args.cash,
            ma=args.ma,
            allocation=args.allocation,
            fee_rate=args.fee_rate,
            slippage_rate=args.slippage_rate,
            max_drawdown_warning_pct=args.max_drawdown_warning_pct,
            data_source=args.data_source,
            data_version=args.data_version,
            adjustment=args.adjustment,
            volume_unit=args.volume_unit,
        )
        sys.stdout.write(
            json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            + "\n"
        )
        return 0
    except BacktestError as error:
        sys.stderr.write(f"backtest input error: {error}\n")
        return 2
    except Exception as error:  # Keep stdout clean even on an unexpected engine failure.
        sys.stderr.write(f"backtest internal error: {type(error).__name__}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

