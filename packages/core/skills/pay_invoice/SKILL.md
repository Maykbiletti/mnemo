---
name: pay_invoice
description: Pay an invoice for the agent's owner. Read the PDF, verify amount + IBAN against expected, execute SEPA via online banking, archive the receipt.
trigger_phrases:
  - 'pay (the )?invoice'
  - 'pay (this )?bill'
  - 'überweise(n)?'
  - 'zahl(e)? (mal )?(die )?rechnung'
  - 'send payment'
sandbox: browser_only
requires_confirmation: true
sensitive_data: ['banking_credentials', 'iban', 'amount']
status: stub
first_recorded_at: 2026-05-01T22:36:00Z
---

## Recipe steps

1. Locate the invoice file (PDF) — either attached to the user's message or referenced by id.
2. Run text-extraction (pdftotext or equivalent). Identify: payee name, IBAN, BIC, amount, currency, due-date, reference/invoice-no.
3. Cross-reference: does this payee exist in `mem_recall("payee X")` history? If new, surface to owner for first-time confirmation.
4. Verify amount against any quote/contract on file. Flag deviations.
5. Open the bank's online portal (predefined URL per owner profile).
6. Log in (use stored credentials, then 2FA push to owner's phone).
7. Open SEPA transfer form, fill payee + IBAN + amount + reference.
8. Capture screenshot of the filled form.
9. Send screenshot to owner. PAUSE for explicit "go" before submitting.
10. After confirmation, click submit, complete bank's 2FA confirmation.
11. Capture receipt PDF, archive to owner's accounting folder.
12. `mem_add({kind:'payment', importance:7, meta_json:{amount, iban, ref}, text:'Paid €X to Y for Z'})`.

## First invocation outcome

(Not yet invoked. Stub recipe.)
