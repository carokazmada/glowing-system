# Meta Messenger webhook security — Carokaz Mada

The POST /webhook endpoint must accept **only authentically signed Meta events**.

Before deploying this security change:

1. In Meta for Developers, find the **App Secret** of the same app used for Messenger webhooks. Keep it private.
2. Set the server environment variable **META_APP_SECRET** securely in the deployment platform. Never put the secret in a GitHub file, public document, query string or log.
3. Confirm PAGE_ACCESS_TOKEN and VERIFY_TOKEN are already configured separately; neither is the App Secret.
4. In staging, verify that valid Meta webhook calls succeed and unsigned/malformed requests receive HTTP 403.
5. Deploy only after the App Secret is set and a rollback is available. A missing secret makes POST /webhook return HTTP 503 by design.

Implementation uses the exact raw request body, HMAC-SHA256 and a constant-time signature comparison. The GET verification challenge remains unchanged.

If tokens in .env.example were ever genuine, rotate/revoke them at the providers and review Git history; changing the current file does not invalidate old credentials.

This pull request is deliberately isolated and should **not** be merged or deployed until the app secret has been configured.
