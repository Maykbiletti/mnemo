---
name: book_flight
description: Book a flight for the agent's owner. Open a flight-search site, compare options, present the top 3, await confirmation, complete the booking with stored payment.
trigger_phrases:
  - 'book (me )?(a )?flight'
  - 'fly (me )?to'
  - 'flight to'
  - 'buch (mir |uns )?(mal )?(nen|einen) flug'
  - 'flieg(e|en) nach'
sandbox: browser_only
requires_confirmation: true
sensitive_data: ['credit_card', 'passport']
status: stub
first_recorded_at: 2026-05-01T22:36:00Z
---

## Recipe steps

1. Parse the user's request: origin, destination, date, return-date, passenger-count, preferences.
2. Open https://www.skyscanner.com (or fallback https://www.google.com/travel/flights).
3. Fill the form: From, To, Depart, Return, Travelers.
4. Sort by price.
5. Capture top 3 options as a screenshot or JSON snippet.
6. Send to owner via Telegram with the cheapest + fastest + most-direct flagged.
7. Await confirmation. If owner replies with a number ("1", "2", "3") or describes the choice, proceed.
8. Click through to booking flow on the chosen flight.
9. Fill passenger details from owner's profile (`mem_who_am_i`).
10. At payment step, fill stored card. PAUSE for second confirmation before clicking "Pay".
11. After confirmation, click "Pay", capture the receipt page.
12. Forward the receipt to owner + log via `mem_add({kind:'receipt', importance:7, ...})`.

## First invocation outcome

(Not yet invoked. This is a stub recipe — the agent should follow it but record any deviations as updates.)
