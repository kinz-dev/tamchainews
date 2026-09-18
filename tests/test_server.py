"""Day 0: who is calling, and what may they spend.

The rest of server.py is I/O against upstream and Microsoft; these are the
pieces that decide whether a request is answered at all, so they are the ones
worth pinning down.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import CharBudget, client_ip, is_trusted  # noqa: E402


class TestTrusted(unittest.TestCase):
    def test_loopback_and_tailnet_are_trusted(self):
        for addr in ("127.0.0.1", "127.1.2.3", "::1", "100.64.0.1",
                     "100.101.102.103", "fd7a:115c:a1e0::1"):
            self.assertTrue(is_trusted(addr), addr)

    def test_the_public_internet_is_not(self):
        for addr in ("8.8.8.8", "1.1.1.1", "2606:4700::1111",
                     "100.63.255.255", "100.128.0.0"):
            self.assertFalse(is_trusted(addr), addr)

    def test_nonsense_is_not_trusted(self):
        for addr in ("", "localhost", "not-an-ip", "999.1.1.1"):
            self.assertFalse(is_trusted(addr), addr)

    def test_scope_and_brackets_are_tolerated(self):
        self.assertTrue(is_trusted("[::1]"))
        self.assertTrue(is_trusted("fd7a:115c:a1e0::1%utun3"))


class TestClientIp(unittest.TestCase):
    def test_plain_connection_is_its_own_peer(self):
        self.assertEqual(client_ip("8.8.8.8", None), "8.8.8.8")

    def test_tailscale_serve_reveals_the_real_caller(self):
        # serve/funnel proxies to loopback; without this every outside caller
        # would look like the owner and skip both the token and the budget.
        self.assertEqual(client_ip("127.0.0.1", "8.8.8.8"), "8.8.8.8")
        self.assertEqual(client_ip("127.0.0.1", "8.8.8.8, 10.0.0.1"), "8.8.8.8")

    def test_forwarded_from_a_stranger_is_ignored(self):
        # Otherwise anyone could spend someone else's budget, or claim to be
        # on the tailnet and skip the token entirely.
        self.assertEqual(client_ip("8.8.8.8", "127.0.0.1"), "8.8.8.8")
        self.assertEqual(client_ip("8.8.8.8", "100.64.0.1"), "8.8.8.8")

    def test_empty_forwarded_falls_back_to_the_peer(self):
        self.assertEqual(client_ip("127.0.0.1", ""), "127.0.0.1")
        self.assertEqual(client_ip("127.0.0.1", " , "), "127.0.0.1")


class TestCharBudget(unittest.TestCase):
    def test_a_charge_within_burst_is_free(self):
        budget = CharBudget(burst=1000, per_hour=3600)
        self.assertEqual(budget.charge("a", 1000, now=0), 0.0)

    def test_going_over_asks_you_to_wait(self):
        budget = CharBudget(burst=1000, per_hour=3600)   # 1 char/sec
        budget.charge("a", 1000, now=0)
        self.assertEqual(budget.charge("a", 10, now=0), 10.0)

    def test_it_refills(self):
        budget = CharBudget(burst=1000, per_hour=3600)
        budget.charge("a", 1000, now=0)
        self.assertEqual(budget.charge("a", 30, now=30), 0.0)

    def test_refill_stops_at_the_burst(self):
        budget = CharBudget(burst=1000, per_hour=3600)
        budget.charge("a", 1000, now=0)
        budget.charge("a", 1000, now=10_000)             # long idle, capped at burst
        self.assertGreater(budget.charge("a", 1, now=10_000), 0.0)

    def test_clients_are_metered_apart(self):
        budget = CharBudget(burst=1000, per_hour=3600)
        budget.charge("a", 1000, now=0)
        self.assertEqual(budget.charge("b", 1000, now=0), 0.0)

    def test_a_refused_charge_takes_nothing(self):
        budget = CharBudget(burst=100, per_hour=3600)
        budget.charge("a", 100, now=0)
        budget.charge("a", 50, now=10)                   # refused: only 10 back
        self.assertEqual(budget.charge("a", 10, now=10), 0.0)

    def test_tracking_is_bounded(self):
        budget = CharBudget(burst=10, per_hour=3600, max_clients=8)
        for n in range(100):
            budget.charge(f"ip-{n}", 1, now=0)
        self.assertLessEqual(len(budget._clients), 8)


if __name__ == "__main__":
    unittest.main()
