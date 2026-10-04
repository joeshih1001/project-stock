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
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP, ROUND_DOWN
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
ENGINE_VERSION = "1.1.0"
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
    sell_fee_rate: Decimal = Decimal('0')
    fee_discount: Decimal = Decimal('1')
    min_fee: Decimal = Decimal('0')
    fee_rounding: str = 'NONE'
    product_type: str = 'UNSPECIFIED'
    lot_size: int = 1
    tax_rate: Decimal = Decimal('0')


@dataclass
class Position:
    trade_id: int
    shares: int
    entry_shares: int
    entry_signal_date: date
    entry_date: date
    entry_index: int
    entry_price: Decimal
    entry_gross: Decimal
    entry_fee: Decimal
    entry_reference_price: Decimal = Decimal('0')
    entry_slippage_cost: Decimal = Decimal('0')
    dividends_received: Decimal = Decimal('0')
    dividend_receivable: Decimal = Decimal('0')

    @property
    def cash_outflow(self) -> Decimal:
        return self.entry_gross + self.entry_fee


@dataclass(frozen=True)
class CorporateAction:
    trading_date: date
    kind: str
    ratio: int = 1
    amount_per_share: Decimal = Decimal(0)
    pay_date: date | None = None


def load_actions(path_value: str | Path) -> tuple[list[CorporateAction], str]:
    try:
        path = Path(path_value).expanduser().resolve(strict=True)
        raw = path.read_bytes()
    except OSError as error:
        raise BacktestError(f'cannot read corporate actions CSV: {error}') from error
    actions: list[CorporateAction] = []
    try:
        contents = raw.decode('utf-8-sig')
    except UnicodeDecodeError as error:
        raise BacktestError('actions CSV must be UTF-8 encoded') from error
    seen: set[tuple[date, str]] = set()
    with io.StringIO(contents, newline='') as stream:
        reader = csv.DictReader(stream, strict=True)
        if reader.fieldnames != ['Date', 'Type', 'Ratio', 'AmountPerShare', 'PayDate']:
            raise BacktestError('actions CSV header must be Date,Type,Ratio,AmountPerShare,PayDate')
        for row in reader:
            if None in row or any(value is None for value in row.values()):
                raise BacktestError('corporate action row has missing or extra columns')
            action_date = _parse_iso_date(row['Date'], 'actions Date')
            kind = row['Type']
            if (action_date, kind) in seen:
                raise BacktestError(f'duplicate {kind} action on {action_date}')
            seen.add((action_date, kind))
            if kind == 'SPLIT':
                try:
                    ratio = int(row['Ratio'])
                except ValueError as error:
                    raise BacktestError('split Ratio must be an integer') from error
                if ratio < 2 or row['AmountPerShare'] or row['PayDate']:
                    raise BacktestError('invalid SPLIT action')
                actions.append(CorporateAction(action_date, kind, ratio=ratio))
            elif kind == 'DIVIDEND':
                amount = _parse_decimal(row['AmountPerShare'], 'dividend AmountPerShare')
                pay_date = _parse_iso_date(row['PayDate'], 'dividend PayDate')
                if amount <= 0 or pay_date < action_date or row['Ratio']:
                    raise BacktestError('invalid DIVIDEND action')
                actions.append(CorporateAction(action_date, kind, amount_per_share=amount, pay_date=pay_date))
            else:
                raise BacktestError(f'unknown corporate action type {kind!r}')
    if any(actions[index].trading_date > actions[index + 1].trading_date for index in range(len(actions) - 1)):
        raise BacktestError('corporate actions must be sorted by Date')
    return actions, hashlib.sha256(raw).hexdigest()


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
        ("sell-fee-rate", config.sell_fee_rate),
        ("fee-discount", config.fee_discount),
        ("min-fee", config.min_fee),
        ("tax-rate", config.tax_rate),
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
    if not 0 <= config.sell_fee_rate < 1 or not 0 <= config.tax_rate < 1:
        raise BacktestError('sell fee rate and tax rate must be between 0 and 1')
    if not 0 <= config.fee_discount <= 1 or config.min_fee < 0:
        raise BacktestError('fee discount and minimum fee must be nonnegative')
    if config.fee_rounding not in ('NONE', 'FLOOR', 'HALF_UP'):
        raise BacktestError('fee rounding must be NONE, FLOOR or HALF_UP')
    if config.product_type not in ('ETF', 'STOCK', 'UNSPECIFIED'):
        raise BacktestError('product type must be ETF, STOCK or UNSPECIFIED')
    if isinstance(config.lot_size, bool) or not isinstance(config.lot_size, int) or config.lot_size < 1:
        raise BacktestError('lot size must be positive')
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


def _fee(gross: Decimal, rate: Decimal, config: BacktestConfig) -> Decimal:
    amount = gross * rate * config.fee_discount if rate else Decimal(0)
    if config.fee_rounding == 'FLOOR':
        amount = amount.quantize(Decimal('1'), rounding=ROUND_DOWN)
    elif config.fee_rounding == 'HALF_UP':
        amount = amount.quantize(Decimal('1'), rounding=ROUND_HALF_UP)
    return max(amount, config.min_fee)


def _affordable_shares(budget: Decimal, price: Decimal, config: BacktestConfig) -> int:
    shares = int((budget / price).to_integral_value(rounding=ROUND_FLOOR))
    shares -= shares % config.lot_size
    while shares >= config.lot_size:
        gross = price * shares
        if gross + _fee(gross, config.fee_rate, config) <= budget:
            return shares
        shares -= config.lot_size
    return 0


def _drawdown_details(curve: Sequence[dict[str, Any]], initial_cash: Decimal, threshold: Decimal) -> dict[str, Any]:
    peak = initial_cash
    current_peak_date: str | None = curve[0]['date'] if curve else None
    max_peak_date: str | None = None
    trough_date: str | None = None
    recovery_date: str | None = None
    max_pct = Decimal(0)
    longest = 0
    underwater_start: date | None = None
    longest_unrecovered = False
    for point in curve:
        current_date = date.fromisoformat(point['date'])
        equity = Decimal(str(point['equity']))
        if equity >= peak:
            if underwater_start is not None:
                days = (current_date - underwater_start).days
                if days > longest:
                    longest = days
                    longest_unrecovered = False
                underwater_start = None
            if recovery_date is None and trough_date is not None:
                recovery_date = point['date']
            if equity > peak:
                peak = equity
                current_peak_date = point['date']
        else:
            if underwater_start is None:
                underwater_start = current_date
            pct = (peak - equity) / peak * 100
            if pct > max_pct:
                max_pct = pct
                trough_date = point['date']
                max_peak_date = current_peak_date
                recovery_date = None
    if underwater_start is not None:
        days = (date.fromisoformat(curve[-1]['date']) - underwater_start).days
        if days > longest:
            longest = days
            longest_unrecovered = True
    return {
        'peakDate': max_peak_date, 'troughDate': trough_date,
        'recoveryDate': recovery_date, 'longestUnderwaterCalendarDays': longest,
        'longestUnderwaterUnrecovered': longest_unrecovered,
        'thresholdExceeded': max_pct > 0 and max_pct >= threshold,
    }


def _closed_trade(
    position: Position,
    *,
    exit_signal_date: date,
    exit_date: date,
    exit_index: int,
    exit_price: Decimal,
    exit_fee: Decimal,
    exit_tax: Decimal = Decimal(0),
    exit_reference_price: Decimal = Decimal(0),
) -> dict[str, Any]:
    exit_gross = exit_price * position.shares
    cash_inflow = exit_gross - exit_fee - exit_tax
    gross_pnl = exit_gross - position.entry_gross
    net_pnl = cash_inflow + position.dividends_received - position.cash_outflow
    return_pct = _percentage(net_pnl, position.cash_outflow)
    return {
        "tradeId": position.trade_id,
        "status": "CLOSED",
        "shares": position.shares,
        "entryShares": position.entry_shares,
        "entrySignalDate": position.entry_signal_date.isoformat(),
        "entryDate": position.entry_date.isoformat(),
        "entryPrice": _number(position.entry_price),
        "entryReferencePrice": _number(position.entry_reference_price),
        "entrySlippageCost": _number(position.entry_slippage_cost),
        "entryGross": _number(position.entry_gross),
        "entryFee": _number(position.entry_fee),
        "entryCashOutflow": _number(position.cash_outflow),
        "dividendCash": _number(position.dividends_received),
        "dividendReceivable": _number(position.dividend_receivable),
        "exitSignalDate": exit_signal_date.isoformat(),
        "exitDate": exit_date.isoformat(),
        "exitPrice": _number(exit_price),
        "exitReferencePrice": _number(exit_reference_price),
        "exitSlippageCost": _number((exit_reference_price - exit_price) * position.shares),
        "exitGross": _number(exit_gross),
        "exitFee": _number(exit_fee),
        "exitTax": _number(exit_tax),
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
    unrealized_pnl = market_value + position.dividends_received + position.dividend_receivable - position.cash_outflow
    unrealized_return = _percentage(unrealized_pnl, position.cash_outflow)
    return {
        "tradeId": position.trade_id,
        "status": "OPEN",
        "shares": position.shares,
        "entryShares": position.entry_shares,
        "entrySignalDate": position.entry_signal_date.isoformat(),
        "entryDate": position.entry_date.isoformat(),
        "entryPrice": _number(position.entry_price),
        "entryReferencePrice": _number(position.entry_reference_price),
        "entrySlippageCost": _number(position.entry_slippage_cost),
        "entryGross": _number(position.entry_gross),
        "entryFee": _number(position.entry_fee),
        "entryCashOutflow": _number(position.cash_outflow),
        "dividendCash": _number(position.dividends_received),
        "dividendReceivable": _number(position.dividend_receivable),
        "exitSignalDate": None,
        "exitDate": None,
        "exitPrice": None,
        "exitReferencePrice": None,
        "exitSlippageCost": None,
        "exitGross": None,
        "exitFee": None,
        "exitTax": None,
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
    dividend_receivable: Decimal,
    total_fees: Decimal,
    total_tax: Decimal,
    total_slippage: Decimal,
    max_drawdown_pct: Decimal,
    bars_in_market: int,
) -> dict[str, Any]:
    final_market_value = bars[-1].close * position.shares if position is not None else Decimal(0)
    final_equity = cash + final_market_value + dividend_receivable
    total_pnl = final_equity - config.initial_cash
    unrealized_pnl = (
        final_market_value + position.dividends_received + position.dividend_receivable - position.cash_outflow if position is not None else Decimal(0)
    )
    realized_pnl = sum(closed_trade_net_pnls, Decimal(0))
    unsettled_closed_dividends = total_pnl - realized_pnl - unrealized_pnl
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
        "finalDividendReceivable": _number(dividend_receivable),
        "finalEquity": _number(final_equity),
        "totalPnl": _number(total_pnl),
        "realizedPnl": _number(realized_pnl),
        "unrealizedPnl": _number(unrealized_pnl),
        "unsettledClosedDividends": _number(unsettled_closed_dividends),
        "totalReturnPct": _number(total_return) if total_return is not None else None,
        "annualizedReturnPct": _annualized_return_pct(
            config.initial_cash, final_equity, bars[0].trading_date, bars[-1].trading_date
        ),
        "maxDrawdownPct": _number(max_drawdown_pct),
        "totalFees": _number(total_fees),
        "totalTax": _number(total_tax),
        "totalSlippageCost": _number(total_slippage),
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
    bars: Sequence[Bar], config: BacktestConfig, trading_start_index: int,
    mode: str = 'strategy', zero_cost: bool = False,
    actions: Sequence[CorporateAction] = (),
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
    total_tax = Decimal(0)
    total_slippage = Decimal(0)
    total_dividends = Decimal(0)
    dividend_receivable = Decimal(0)
    receivables: list[tuple[date, Decimal, int]] = []
    closed_trade_indexes: dict[int, int] = {}
    actions_by_date: dict[date, list[CorporateAction]] = {}
    for action in actions:
        actions_by_date.setdefault(action.trading_date, []).append(action)
    peak_equity = config.initial_cash
    max_drawdown_pct = Decimal(0)
    bars_in_market = 0
    insufficient_budget_count = 0

    for index in range(trading_start_index, len(bars)):
        bar = bars[index]
        moving_average = moving_averages[index]
        trading_index = index - trading_start_index
        daily_fees = Decimal(0)
        daily_tax = Decimal(0)
        daily_dividends = Decimal(0)
        for action in actions_by_date.get(bar.trading_date, []):
            if position is None:
                continue
            if action.kind == 'SPLIT':
                position.shares *= action.ratio
            else:
                amount = action.amount_per_share * position.shares
                position.dividend_receivable += amount
                dividend_receivable += amount
                receivables.append((action.pay_date or action.trading_date, amount, position.trade_id))
        for pay_date, amount, trade_id in list(receivables):
            if pay_date > bar.trading_date:
                continue
            cash += amount
            dividend_receivable -= amount
            daily_dividends += amount
            total_dividends += amount
            receivables.remove((pay_date, amount, trade_id))
            if position is not None and position.trade_id == trade_id:
                position.dividends_received += amount
                position.dividend_receivable -= amount
            else:
                closed_index = closed_trade_indexes[trade_id]
                trade = closed_trades[closed_index]
                trade['dividendCash'] = _number(Decimal(str(trade['dividendCash'])) + amount)
                trade['dividendReceivable'] = _number(Decimal(str(trade['dividendReceivable'])) - amount)
                updated_pnl = Decimal(str(trade['netPnl'])) + amount
                trade['netPnl'] = _number(updated_pnl)
                pnl_pct = _percentage(updated_pnl, Decimal(str(trade['entryCashOutflow'])))
                trade['returnPct'] = _number(pnl_pct) if pnl_pct is not None else None
                closed_trade_net_pnls[closed_index] += amount
        if mode != 'strategy' and trading_index == 0:
            pending = ('BUY', bar.trading_date)
        if pending is not None:
            action, signal_date = pending
            if action == "BUY" and position is None:
                fill_price = bar.open * (Decimal(1) + (Decimal(0) if zero_cost else config.slippage_rate))
                budget = cash * (Decimal(1) if mode == 'benchmark100' else Decimal('0.5') if mode == 'benchmark50' else config.allocation)
                shares = _affordable_shares(budget, fill_price, config) if not zero_cost else int((budget / fill_price).to_integral_value(rounding=ROUND_FLOOR)) // config.lot_size * config.lot_size
                if shares >= 1:
                    entry_gross = fill_price * shares
                    entry_fee = Decimal(0) if zero_cost else _fee(entry_gross, config.fee_rate, config)
                    entry_slippage = (fill_price - bar.open) * shares
                    cash -= entry_gross + entry_fee
                    total_fees += entry_fee
                    total_slippage += entry_slippage
                    daily_fees += entry_fee
                    position = Position(
                        trade_id=next_trade_id,
                        shares=shares,
                        entry_shares=shares,
                        entry_signal_date=signal_date,
                        entry_date=bar.trading_date,
                        entry_index=trading_index,
                        entry_price=fill_price,
                        entry_gross=entry_gross,
                        entry_fee=entry_fee,
                        entry_reference_price=bar.open,
                        entry_slippage_cost=entry_slippage,
                    )
                    next_trade_id += 1
                else:
                    insufficient_budget_count += 1
            elif action == "SELL" and position is not None:
                fill_price = bar.open * (Decimal(1) - (Decimal(0) if zero_cost else config.slippage_rate))
                exit_gross = fill_price * position.shares
                exit_fee = Decimal(0) if zero_cost else _fee(exit_gross, config.sell_fee_rate, config)
                exit_tax = Decimal(0) if zero_cost else (exit_gross * config.tax_rate).quantize(Decimal('1'), rounding=ROUND_DOWN)
                total_slippage += (bar.open - fill_price) * position.shares
                cash += exit_gross - exit_fee - exit_tax
                total_fees += exit_fee
                total_tax += exit_tax
                daily_fees += exit_fee
                daily_tax += exit_tax
                closed_trade_net_pnls.append(
                    exit_gross - exit_fee - exit_tax + position.dividends_received - position.cash_outflow
                )
                closed_trade_indexes[position.trade_id] = len(closed_trades)
                closed_trades.append(
                    _closed_trade(
                        position,
                        exit_signal_date=signal_date,
                        exit_date=bar.trading_date,
                        exit_index=trading_index,
                        exit_price=fill_price,
                        exit_fee=exit_fee,
                        exit_tax=exit_tax,
                        exit_reference_price=bar.open,
                    )
                )
                position = None
            pending = None

        market_value = bar.close * position.shares if position is not None else Decimal(0)
        equity = cash + market_value + dividend_receivable
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
                "holdings": {config.symbol: position.shares} if position is not None else {},
                "marketValue": _number(market_value),
                "dividendReceivable": _number(dividend_receivable),
                "dailyFees": _number(daily_fees),
                "dailyTax": _number(daily_tax),
                "dividendsReceived": _number(daily_dividends),
                "highWaterMark": _number(peak_equity),
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
        ) if mode == 'strategy' else 'HOLD'
        if signal != "HOLD":
            pending = (signal, bar.trading_date)

    if mode == 'strategy' and not any(
        moving_average is not None
        for moving_average in moving_averages[trading_start_index:]
    ):
        warnings.append(
            _warning(
                "INSUFFICIENT_MA_HISTORY",
                f"MA({config.ma_period}) never becomes available during the requested range.",
            )
        )
    elif mode == 'strategy' and trading_start_index < config.ma_period - 1:
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
    if dividend_receivable:
        warnings.append(_warning('UNPAID_DIVIDEND_RECEIVABLE', f'期末仍有 {_number(dividend_receivable)} 元股息應收未入帳。'))

    metrics = _metrics(
        config=config,
        bars=trading_bars,
        equity_values=equity_values,
        closed_trades=closed_trades,
        closed_trade_net_pnls=closed_trade_net_pnls,
        position=position,
        cash=cash,
        dividend_receivable=dividend_receivable,
        total_fees=total_fees,
        total_tax=total_tax,
        total_slippage=total_slippage,
        max_drawdown_pct=max_drawdown_pct,
        bars_in_market=bars_in_market,
    )
    metrics.update(_drawdown_details(equity_curve, config.initial_cash, config.max_drawdown_warning_pct))
    metrics['totalDividendsReceived'] = _number(total_dividends)
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
    sell_fee_rate: Decimal | None = None,
    fee_discount: Decimal = Decimal('1'),
    min_fee: Decimal = Decimal('0'),
    fee_rounding: str = 'NONE',
    product_type: str = 'UNSPECIFIED',
    lot_size: int = 1,
    tax_rate: Decimal = Decimal('0'),
    slippage_rate: Decimal = Decimal("0"),
    max_drawdown_warning_pct: Decimal = Decimal("20"),
    data_source: str = "local-csv",
    data_version: str | None = None,
    adjustment: str = "unspecified",
    volume_unit: str = "unspecified",
    actions_path: str | Path | None = None,
    actions_verified: bool = False,
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
        sell_fee_rate=fee_rate if sell_fee_rate is None else sell_fee_rate,
        fee_discount=fee_discount,
        min_fee=min_fee,
        fee_rounding=fee_rounding,
        product_type=product_type,
        lot_size=lot_size,
        tax_rate=tax_rate,
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
    if actions_path is not None and adjustment_value not in ('raw', 'unadjusted'):
        raise BacktestError('corporate actions require raw, unadjusted OHLC; adjusted prices would double count actions')
    if actions_verified and actions_path is None:
        raise BacktestError('actions-verified requires an actions CSV')
    actions, actions_hash = load_actions(actions_path) if actions_path is not None else ([], None)

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
    crosses_0050_split = (
        config.symbol in ('0050', '0050.TW')
        and selected_bars[0].trading_date <= date(2025, 6, 10)
        and selected_bars[-1].trading_date >= date(2025, 6, 18)
    )
    if actions_verified and crosses_0050_split and not any(
        action.kind == 'SPLIT' and action.trading_date == date(2025, 6, 18) and action.ratio == 4
        for action in actions
    ):
        raise BacktestError('verified 0050 actions must include the official 4:1 split on 2025-06-18')
    trading_dates = {bar.trading_date for bar in selected_bars}
    for action in actions:
        if selected_bars[0].trading_date <= action.trading_date <= selected_bars[-1].trading_date and action.trading_date not in trading_dates:
            raise BacktestError(f'corporate action date {action.trading_date} has no matching trading bar')

    engine_result, warnings = _run_engine(
        bars_through_end, config, trading_start_index, actions=actions
    )
    benchmark100, _ = _run_engine(bars_through_end, config, trading_start_index, 'benchmark100', actions=actions)
    benchmark50, _ = _run_engine(bars_through_end, config, trading_start_index, 'benchmark50', actions=actions)
    no_cost, _ = _run_engine(bars_through_end, config, trading_start_index, zero_cost=True, actions=actions)
    accounting_status = 'INCOMPLETE' if adjustment_value not in ('raw', 'unadjusted') else 'ASSUMED_COST' if actions_verified and actions_path is not None else 'PENDING_CORPORATE_ACTIONS'
    if accounting_status != 'ASSUMED_COST':
        warnings.append(_warning('CORPORATE_ACTIONS_UNVERIFIED', '公司行動、股息與拆股權利尚未核對；資產曲線只是價格序列模擬，並非可對帳的現金紀錄。'))
    if adjustment_value not in ('raw', 'unadjusted'):
        warnings.append(_warning('ADJUSTED_PRICE_PROXY', '調整後 OHLC 是合成價格，不能代表歷史可成交價格或實際股數。'))
    if accounting_status != 'ASSUMED_COST' and crosses_0050_split:
        warnings.append(_warning('0050_SPLIT_UNRECONCILED', '0050 於 2025-06-18 進行 4:1 分割，尚未以原始價格與持股核對；證交所公告：https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other'))
    if config.product_type == 'UNSPECIFIED' and config.tax_rate == 0:
        warnings.append(_warning('SELL_TAX_UNCONFIRMED', '商品種類尚未確認，賣出交易稅可能未計入。'))
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
            "sellFeeRate": _number(config.sell_fee_rate),
            "feeDiscount": _number(config.fee_discount),
            "minFee": _number(config.min_fee),
            "feeRounding": config.fee_rounding,
            "productType": config.product_type,
            "lotSize": config.lot_size,
            "taxRate": _number(config.tax_rate),
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
            "timezone": "Asia/Taipei",
            "columns": list(REQUIRED_COLUMNS),
            "pricePrecision": "as-provided-by-source",
            "corporateActionsSha256": actions_hash,
            "corporateActionsFileName": Path(actions_path).name if actions_path is not None else None,
            "corporateActionsVerified": actions_verified,
            "rowsInFile": len(bars),
            "rowsInRange": len(selected_bars),
            "warmupRows": trading_start_index,
            "fileFirstDate": bars[0].trading_date.isoformat(),
            "fileLastDate": bars[-1].trading_date.isoformat(),
            "firstDate": selected_bars[0].trading_date.isoformat(),
            "lastDate": selected_bars[-1].trading_date.isoformat(),
        },
        "metrics": engine_result["metrics"],
        "noCostMetrics": no_cost['metrics'],
        "benchmarks": {
            'buyHold100': benchmark100,
            'buyHold50': benchmark50,
        },
        "accountingStatus": accounting_status,
        "assumptions": {
            'brokerFeeSchedule': 'USER_ASSUMPTION_UNVERIFIED',
            'sellTax': 'user-provided rate; ETF 0.001 or STOCK 0.003 applied by Node API for 2018 onward',
            'sellTaxSource': 'https://www.etax.nat.gov.tw/etwmain/tax-info/understanding/tax-saving-manual/national/securities-transaction-tax/JNxPwlJ',
            'sellTaxRuleCheckedAt': '2026-10-05',
            'sellTaxRounding': 'ROUND_DOWN_TO_TWD',
            'spread': 'included-in-slippage-assumption',
            'cashInterestRate': 0,
            'dividendReinvestment': False,
            'personalDividendTax': 'EXCLUDED',
            'operatingCosts': 'EXCLUDED',
            'endOfPeriod': 'MARK_TO_MARKET_WITHOUT_HYPOTHETICAL_EXIT_COST',
            'execution': 'daily OHLC next open; no order book or price-limit fill simulation',
        },
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
    parser.add_argument('--sell-fee-rate', type=_decimal_arg)
    parser.add_argument('--fee-discount', type=_decimal_arg, default=Decimal('1'))
    parser.add_argument('--min-fee', type=_decimal_arg, default=Decimal('0'))
    parser.add_argument('--fee-rounding', choices=('NONE', 'FLOOR', 'HALF_UP'), default='NONE')
    parser.add_argument('--product-type', choices=('ETF', 'STOCK', 'UNSPECIFIED'), default='UNSPECIFIED')
    parser.add_argument('--lot-size', type=int, default=1)
    parser.add_argument('--tax-rate', type=_decimal_arg, default=Decimal('0'))
    parser.add_argument('--actions', help='verified raw-price corporate actions CSV')
    parser.add_argument('--actions-verified', action='store_true')
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
            sell_fee_rate=args.sell_fee_rate,
            fee_discount=args.fee_discount,
            min_fee=args.min_fee,
            fee_rounding=args.fee_rounding,
            product_type=args.product_type,
            lot_size=args.lot_size,
            tax_rate=args.tax_rate,
            slippage_rate=args.slippage_rate,
            max_drawdown_warning_pct=args.max_drawdown_warning_pct,
            data_source=args.data_source,
            data_version=args.data_version,
            adjustment=args.adjustment,
            volume_unit=args.volume_unit,
            actions_path=args.actions,
            actions_verified=args.actions_verified,
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
