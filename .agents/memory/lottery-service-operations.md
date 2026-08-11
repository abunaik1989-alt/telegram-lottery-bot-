---
name: Lottery service operations
description: Durable product rules for the Telegram lottery service.
---

The lottery uses a reservation-before-payment workflow: customers select an available number, submit Bank or Telebirr proof, and the organizer approves it before the number becomes paid and eligible for the draw.

**Why:** This separates temporary customer intent from verified payment and prevents unpaid entries from entering the winner pool.

**How to apply:** Keep available, reserved, proof-pending, paid, and released states distinct in future UI or API changes; only paid entries may be drawn, and the draw must remain one-time.