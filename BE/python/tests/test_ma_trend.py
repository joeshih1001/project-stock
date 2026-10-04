from __future__ import annotations

import unittest
from decimal import Decimal

from python.strategies.ma_trend import signal_at_close, simple_moving_average


class MovingAverageTrendTests(unittest.TestCase):
    def test_sma_is_aligned_and_includes_current_close(self) -> None:
        values = [Decimal("10"), Decimal("12"), Decimal("8"), Decimal("14")]

        self.assertEqual(
            simple_moving_average(values, 2),
            [None, Decimal("11"), Decimal("10"), Decimal("11")],
        )

    def test_signal_targets_long_above_and_flat_below(self) -> None:
        average = Decimal("10")

        self.assertEqual(
            signal_at_close(
                currently_long=False, close=Decimal("11"), moving_average=average
            ),
            "BUY",
        )
        self.assertEqual(
            signal_at_close(
                currently_long=True, close=Decimal("9"), moving_average=average
            ),
            "SELL",
        )
        self.assertEqual(
            signal_at_close(
                currently_long=False, close=average, moving_average=average
            ),
            "HOLD",
        )
        self.assertEqual(
            signal_at_close(
                currently_long=True, close=average, moving_average=average
            ),
            "HOLD",
        )

    def test_period_and_values_are_validated(self) -> None:
        with self.assertRaisesRegex(ValueError, "period"):
            simple_moving_average([Decimal("1")], 1)
        with self.assertRaisesRegex(ValueError, r"values\[0\]"):
            simple_moving_average([Decimal("NaN"), Decimal("1")], 2)


if __name__ == "__main__":
    unittest.main()

