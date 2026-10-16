# Google verification: Missive's Gmail access

Missive connects a person's Gmail so their mail shows up, gets sorted, and can
be answered from Missive. Gmail's scopes are **restricted**, so before more
than 100 people can connect (and before the "Google hasn't verified this app"
warning goes away) the OAuth app has to pass Google's verification, which for
restricted scopes includes an annual third-party security assessment (CASA).

The Gmail OAuth client lives in its own Google Cloud project, **missive-gmail**
(project number 542492217893, organization theaiinc.com), separate from
`aegis-idp` (Aegis sign-in, which must not inherit a restricted-scope review)
and `missive-calendar` (Google Calendar, read-only).

## 1. Consent screen (Google Auth Platform → Branding)

| Field | Value |
| --- | --- |
| App name | Missive |
| User support email | info@theaiinc.com |
| App logo | `packages/web/public/icon-512.png` (120×120 px or larger, square) |
| Application home page | https://missive.theaiinc.com/about.html |
| Privacy policy | https://missive.theaiinc.com/privacy.html |
| Terms of service | https://missive.theaiinc.com/terms.html |
| Authorized domains | theaiinc.com, bugmole.com |
| Developer contact | info@theaiinc.com |

Both authorized domains must be verified in Google Search Console by an owner
of the project. bugmole.com is only needed because `mail.bugmole.com` is a
Missive site with its own redirect URI; dropping that redirect (connecting
Gmail only from missive.theaiinc.com) removes it.

**Audience**: External, In production (Testing mode limits sign-in to listed
test users and expires refresh tokens after 7 days).

## 2. OAuth client (Clients → Create client)

- Type: Web application, name "Missive web"
- Authorized redirect URIs:
  - `https://missive.theaiinc.com/oauth`
  - `https://mail.bugmole.com/oauth`
- Its ID and secret replace `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` on the
  `missive` Worker. Accounts connected with the old client (in `aegis-idp`)
  must reconnect once.

## 3. Scopes (Data Access)

Missive requests exactly two Gmail scopes, plus the address to label the
account. `gmail.readonly` is not requested: `gmail.modify` covers reading.

| Scope | Class | Used for | Code |
| --- | --- | --- | --- |
| `gmail.modify` | Restricted | Read the person's mail to show it in Missive, sorted into folders; mark messages read/unread in Gmail when they read or unread them in Missive, so both stay in step. Missive never deletes Gmail mail. | `sync.service.ts` (list, get), `gmail-send.service.ts` (`batchModify` of the `UNREAD` label only) |
| `gmail.send` | Sensitive | Send replies and new mail from the person's own Gmail address when they press Send in Missive. | `gmail-send.service.ts` (`messages.send`) |
| `userinfo.email` | Non-sensitive | Show which Gmail address is connected. | `connector.store.ts` |

### Justification text (paste per scope)

**gmail.modify**: "Missive is an email client. When a user connects Gmail,
Missive reads their messages to display them in the user's Missive inbox,
search them, and sort them into folders the user can see. When the user opens
a message (or marks it unread) in Missive, Missive updates only the UNREAD
label in Gmail so the read state matches. Missive does not delete, trash or
otherwise change the user's Gmail mail. A narrower scope is insufficient:
gmail.readonly cannot change the UNREAD label, and gmail.metadata cannot read
message bodies or search."

**gmail.send**: "Users reply to and write email in Missive. When they press
Send on a message from their connected Gmail address, Missive sends it through
the Gmail API so it comes from their own address and appears in their Gmail
Sent folder. Missive only sends mail the user wrote and explicitly sent."

## 4. Demo video (YouTube, unlisted)

Google needs one video showing the whole OAuth flow and each scope in use.
Record at missive.theaiinc.com with a test Gmail account; 3–5 minutes; no
editing between the consent screen and the result.

1. Show the browser address bar on https://missive.theaiinc.com and sign in.
2. Settings → Accounts → **Connect Gmail**. On Google's consent screen, pause
   so the **app name "Missive"** and the **OAuth client ID in the URL**
   (`client_id=…`) are readable; show the listed permissions. Click Allow.
3. Back in Missive: the account appears under Settings; open the Inbox and
   show Gmail messages arriving (**gmail.modify: reading**). Search for a word
   from one of them.
4. Open an unread message in Missive, then show the same message now read in
   Gmail in another tab (**gmail.modify: UNREAD label**).
5. Reply to a message from Missive and press Send; show it in Gmail's Sent
   folder from the user's own address (**gmail.send**).
6. Settings → disconnect the account; show it removed. Mention that access can
   also be revoked at myaccount.google.com/permissions.
7. Show https://missive.theaiinc.com/privacy.html briefly, scrolling to the
   Google API Services User Data Policy / Limited Use statement.

## 5. Security assessment (CASA)

Required yearly for restricted scopes. After submission, Google's review team
emails the assessment tier (usually Tier 2 for an app like this) and the list
of authorized labs. Missive's posture to describe:

- Mail content, sender/recipients and OAuth tokens are encrypted at rest
  (per-user keys derived from a master key held outside the database; see
  `core/src/crypto.ts`, `storage/content-crypto.ts`).
- Row-level security in Postgres: every query runs as a restricted role scoped
  to the signed-in user (`storage/postgres.service.ts`).
- TLS everywhere (Cloudflare in front of the Worker and the API container).
- Disconnecting deletes stored tokens immediately; full deletion on request
  within 30 days (privacy policy).
- AI: mail excerpts go only to Cloudflare Workers AI (no training, no
  retention); Google Calendar data never goes to AI (privacy policy, "AI
  features").

## 6. Submit (Verification Center)

Only a project owner can submit, and submitting attests the information is
accurate, so a person does it: Google Auth Platform → Verification Center →
**Prepare for verification**, paste the scope justifications, add the video
link, confirm, Submit. Then answer Google's follow-up emails to
info@theaiinc.com and book the CASA assessment.
