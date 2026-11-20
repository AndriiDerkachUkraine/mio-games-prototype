# Sample requests and responses

Captured verbatim from the compose stack (`docker compose up --build`) with a script, not written by hand.
Ids and timestamps are from that run and the player token is shortened. Repeated calls (a second deposit and
a second spin, made so the player can afford an item) are omitted, which is why the wallet shows two credits.

Requests on port 4100 go to the casino simulator, which signs webhooks and tokens the way the casinos do;
everything on port 3100 is MIO itself. Runnable versions are in [`http/mio.http`](../http/mio.http)
(JetBrains HTTP Client), and `npm run demo` drives the whole flow including failure scenarios.

### 1. Casino A sends a deposit (via the simulator)

```http
POST http://localhost:4100/__simulate/casino-a/deposit
content-type: application/json

{
  "playerId": "player-exmwovhj0i",
  "amount": "25.00"
}
```

Response `200`:

```json
{
  "sent": {
    "event_id": "1726d47e-1fdd-4233-9ef3-cf08ed1f179f",
    "event_type": "deposit",
    "player_id": "player-exmwovhj0i",
    "amount_cents": 2500,
    "currency": "EUR",
    "status": "SUCCESS"
  },
  "mio": {
    "status": 200,
    "body": {
      "status": "processed",
      "eventId": "79518e83-d538-49b4-b9ae-1918bc5ecb76",
      "spinsGranted": 1
    }
  }
}
```

### 2. Casino issues a player session token

```http
POST http://localhost:4100/__simulate/casino-a/player-token
content-type: application/json

{
  "playerId": "player-exmwovhj0i"
}
```

Response `200`:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs…"
}
```

### 3. List available spins

```http
GET http://localhost:3100/v1/me/spins
authorization: Bearer <token>
```

Response `200`:

```json
{
  "available": [
    {
      "spinId": "5790fa2f-4675-4645-bb1c-49af662eebe4",
      "grantedAt": "2026-11-20T11:05:19.042Z"
    },
    {
      "spinId": "58fa1a7c-7cfc-44d8-bf86-d51ca93dfdac",
      "grantedAt": "2026-11-20T11:05:19.069Z"
    }
  ]
}
```

### 4. Spin the wheel

```http
POST http://localhost:3100/v1/me/spins/5790fa2f-4675-4645-bb1c-49af662eebe4/play
authorization: Bearer <token>
```

Response `200`:

```json
{
  "spinId": "5790fa2f-4675-4645-bb1c-49af662eebe4",
  "segment": {
    "key": "coins-25",
    "label": "25 coins",
    "coins": 25
  },
  "rewardTableVersion": 4,
  "playedAt": "2026-11-20T11:05:19.101Z"
}
```

### 5. Wallet

```http
GET http://localhost:3100/v1/me/wallet
authorization: Bearer <token>
```

Response `200`:

```json
{
  "balance": 35,
  "entries": [
    {
      "kind": "SPIN_REWARD",
      "amount": 10,
      "balanceAfter": 35,
      "referenceId": "58fa1a7c-7cfc-44d8-bf86-d51ca93dfdac",
      "createdAt": "2026-11-20T11:05:19.115Z"
    },
    {
      "kind": "SPIN_REWARD",
      "amount": 25,
      "balanceAfter": 25,
      "referenceId": "5790fa2f-4675-4645-bb1c-49af662eebe4",
      "createdAt": "2026-11-20T11:05:19.101Z"
    }
  ]
}
```

### 6. Bonus Store

```http
GET http://localhost:3100/v1/store/items
authorization: Bearer <token>
```

Response `200`:

```json
{
  "items": [
    {
      "itemId": "2ce906f8-1c2a-4774-8ec0-808d266519de",
      "sku": "free-spins-10",
      "name": "10 free spins on Book of MIO",
      "priceCoins": 20,
      "reward": {
        "type": "FREE_SPINS",
        "quantity": 10,
        "game": "book-of-mio"
      }
    },
    {
      "itemId": "769f6106-0aa7-4097-bf2e-c931d501da14",
      "sku": "bonus-5-eur",
      "name": "EUR 5 bonus money",
      "priceCoins": 100,
      "reward": {
        "type": "BONUS_MONEY",
        "amountMinor": 500,
        "currency": "EUR"
      }
    }
  ]
}
```

### 7. Redeem

```http
POST http://localhost:3100/v1/me/redemptions
authorization: Bearer <token>
idempotency-key: order-exmwovhj0i
content-type: application/json

{
  "itemId": "2ce906f8-1c2a-4774-8ec0-808d266519de"
}
```

Response `202`:

```json
{
  "redemptionId": "20339a46-159b-43f8-ac3e-0dcde0173322",
  "itemId": "2ce906f8-1c2a-4774-8ec0-808d266519de",
  "priceCoins": 20,
  "reward": {
    "type": "FREE_SPINS",
    "quantity": 10,
    "game": "book-of-mio"
  },
  "status": "PENDING",
  "externalReference": null,
  "failureReason": null,
  "attempts": 0,
  "createdAt": "2026-11-20T11:05:19.142Z",
  "updatedAt": "2026-11-20T11:05:19.142Z"
}
```

### 8. Redeem again with the same key

```http
POST http://localhost:3100/v1/me/redemptions
authorization: Bearer <token>
idempotency-key: order-exmwovhj0i
content-type: application/json

{
  "itemId": "2ce906f8-1c2a-4774-8ec0-808d266519de"
}
```

Response `200`:

```json
{
  "redemptionId": "20339a46-159b-43f8-ac3e-0dcde0173322",
  "itemId": "2ce906f8-1c2a-4774-8ec0-808d266519de",
  "priceCoins": 20,
  "reward": {
    "type": "FREE_SPINS",
    "quantity": 10,
    "game": "book-of-mio"
  },
  "status": "PENDING",
  "externalReference": null,
  "failureReason": null,
  "attempts": 0,
  "createdAt": "2026-11-20T11:05:19.142Z",
  "updatedAt": "2026-11-20T11:05:19.142Z"
}
```

### 9. Redemption status

```http
GET http://localhost:3100/v1/me/redemptions/20339a46-159b-43f8-ac3e-0dcde0173322
authorization: Bearer <token>
```

Response `200`:

```json
{
  "redemptionId": "20339a46-159b-43f8-ac3e-0dcde0173322",
  "itemId": "2ce906f8-1c2a-4774-8ec0-808d266519de",
  "priceCoins": 20,
  "reward": {
    "type": "FREE_SPINS",
    "quantity": 10,
    "game": "book-of-mio"
  },
  "status": "ISSUED",
  "externalReference": "6aa1c1ab-71df-4004-96d1-59dc6558c7d9",
  "failureReason": null,
  "attempts": 1,
  "createdAt": "2026-11-20T11:05:19.142Z",
  "updatedAt": "2026-11-20T11:05:19.890Z",
  "history": [
    {
      "from": null,
      "to": "PENDING",
      "detail": "20 coins debited",
      "at": "2026-11-20T11:05:19.142Z"
    },
    {
      "from": "PENDING",
      "to": "ISSUED",
      "detail": "attempt 1: issued",
      "at": "2026-11-20T11:05:19.890Z"
    }
  ]
}
```

### 10. Forged webhook

```http
POST http://localhost:3100/v1/integrations/casino-a/events
x-timestamp: 1795170000
x-signature: sha256=forged
content-type: application/json

{
  "event_id": "x",
  "event_type": "deposit",
  "player_id": "player-exmwovhj0i",
  "amount_cents": 999999,
  "currency": "EUR",
  "status": "SUCCESS"
}
```

Response `401`:

```json
{
  "error": "UNAUTHORIZED_EVENT",
  "message": "invalid signature"
}
```

### 11. No token

```http
GET http://localhost:3100/v1/me/wallet
```

Response `401`:

```json
{
  "error": "UNAUTHORIZED_PLAYER",
  "message": "missing bearer token"
}
```

### 12. Admin: reward table versions

```http
GET http://localhost:3100/v1/admin/reward-tables
x-admin-key: dev-casino-b-admin-key
```

Response `200`:

```json
{
  "versions": [
    {
      "id": "66d0ec7a-542c-4382-b463-870f703efd04",
      "version": 1,
      "segments": [
        {
          "key": "coins-10",
          "label": "10 coins",
          "coins": 10,
          "weight": 50
        },
        {
          "key": "coins-25",
          "label": "25 coins",
          "coins": 25,
          "weight": 30
        },
        {
          "key": "coins-50",
          "label": "50 coins",
          "coins": 50,
          "weight": 15
        },
        {
          "key": "coins-200",
          "label": "200 coins (jackpot)",
          "coins": 200,
          "weight": 5
        }
      ],
      "active": true,
      "createdBy": "seed",
      "createdAt": "2026-11-20T09:06:33.496Z"
    }
  ]
}
```

### 13. Admin: review queue

```http
GET http://localhost:3100/v1/admin/redemptions?status=MANUAL_REVIEW
x-admin-key: dev-casino-a-admin-key
```

Response `200`:

```json
{
  "redemptions": []
}
```
