"""Long-only moving-average trend strategy.

The strategy observes a completed daily close.  A close above the moving
average requests a long position; a close below it requests a flat position.
Equality does not change the current position.  Execution timing is deliberately
kept out of this module and is handled by the engine on the next trading day's
open.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal, Sequence


STRATEGY_NAME = "ma-trend"
STRATEGY_VERSION = "1.0.0"

Signal = Literal["BUY", "SELL", "HOLD"]


def simple_moving_average(
    values: Sequence[Decimal], period: int
) -> list[Decimal | None]:
    """Return an SMA aligned with *values*, with ``None`` during warm-up."""

    if isinstance(period, bool) or not isinstance(period, int) or period < 2:
        raise ValueError("period must be an integer greater than or equal to 2")

    result: list[Decimal | None] = [None] * len(values)
    rolling_sum = Decimal("0")

    for index, value in enumerate(values):
        if not isinstance(value, Decimal) or not value.is_finite():
            raise ValueError(f"values[{index}] must be a finite Decimal")
        rolling_sum += value
        if index >= period:
            rolling_sum -= values[index - period]
        if index >= period - 1:
            result[index] = rolling_sum / period

    return result


def signal_at_close(
    *, currently_long: bool, close: Decimal, moving_average: Decimal | None
) -> Signal:
    """Return the order signal confirmed by the current day's closing price."""

    if moving_average is None:
        return "HOLD"
    if close > moving_average and not currently_long:
        return "BUY"
    if close < moving_average and currently_long:
        return "SELL"
    return "HOLD"

