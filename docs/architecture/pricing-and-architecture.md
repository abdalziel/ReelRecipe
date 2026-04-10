# ReelRecipe — Pricing & Architecture Plan

## 1. Instagram / Meta API Reality Check

### What exists today
| API | What it does | Useful for us? |
|---|---|---|
| **Facebook Login / Instagram Login** | OAuth sign-in, profile photo | Yes — user authentication only |
| **Instagram Graph API** | Read/post from business & creator accounts | No — personal accounts excluded |
| **Instagram Basic Display API** | Read a user's own media | **Shut down December 2024** |
| **Saved Posts API** | Read a user's saved posts | **Does not exist** |

### Practical path forward
- **"Sign in with Instagram"** can be added for identity/authentication (no extra scraping risk)
- **Saved-posts bulk import** via Instaloader remains against Instagram's ToS at commercial scale; acceptable for personal/beta use but must be addressed before public App Store launch
- **Safest import method at scale**: user saves the reel to their camera roll, uploads the video file directly — no Instagram involvement, no ToS conflict
- **Single-reel URL import** (public posts only, no login) is a middle ground and the least risky automated approach
- If Meta opens a saved-posts API in future, the architecture below is ready to plug it in

---

## 2. AWS Production Architecture

### High-level stack

```
Users (iOS / Android / Web)
        │
        ▼
   CloudFront CDN  ──────────────────── S3 (thumbnails, uploaded videos, static web)
        │
        ▼
Application Load Balancer (HTTPS, ACM certificate)
        │
        ▼
   ECS Fargate  (2+ tasks, auto-scaling)
   ┌─────────────────────────────────┐
   │  FastAPI backend                │
   │  Faster-Whisper (transcription) │
   │  Import job worker              │
   └─────────────────────────────────┘
        │                    │
        ▼                    ▼
  RDS PostgreSQL        SQS Queue
  (Multi-AZ, encrypted) (per-user import jobs)
        │
        ▼
  Secrets Manager
  (Anthropic API key, DB credentials)
```

### Key architectural changes from current (single-user) to multi-user

| Concern | Current | Production |
|---|---|---|
| Database | SQLite (single file) | RDS PostgreSQL (multi-user, concurrent) |
| File storage | Local filesystem | S3 + CloudFront |
| Import job state | Global in-memory dict | Per-user job record in DB + SQS |
| Authentication | None | Cognito or Auth0 (JWT tokens) |
| Secrets | `.env` file | AWS Secrets Manager |
| Transcription | Local Faster-Whisper | Runs inside Fargate task (same) |
| Thumbnail serving | Direct from server | CloudFront → S3 |

### Why SQS for import jobs?
The current single-user in-memory job tracker breaks immediately with multiple users. SQS gives each user their own import queue: jobs are durable (survive server restarts), rate-limiting is per-user, and multiple Fargate tasks can process in parallel.

---

## 3. Cost Model

### AWS infrastructure costs (monthly estimates)

| Service | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| ECS Fargate (2–4 tasks) | $30 | $75 | $250 |
| RDS PostgreSQL (t3.small → t3.medium) | $25 | $60 | $180 |
| S3 storage (thumbnails + uploads) | $3 | $12 | $80 |
| CloudFront (data transfer) | $2 | $10 | $70 |
| ALB | $18 | $18 | $35 |
| SQS | <$1 | $2 | $15 |
| Secrets Manager + misc | $5 | $8 | $15 |
| **Total infrastructure** | **~$83** | **~$185** | **~$645** |

> **Storage note**: A user's recipe library is mostly text (negligible) plus thumbnails (~100 KB each). A library of 200 recipes = ~20 MB in S3. At 10,000 users that's ~200 GB = ~$4.60/month in S3 storage — not a meaningful cost driver. The compute (Fargate + RDS) is what scales.

### Claude API costs (per recipe import)

| Step | Tokens | Cost |
|---|---|---|
| Input (prompt + transcript + caption) | ~3,000 tokens | $0.009 |
| Output (structured recipe JSON) | ~800 tokens | $0.012 |
| **Per recipe** | | **~$0.02** |

| Monthly active users | Avg new imports/user/month | Claude cost |
|---|---|---|
| 100 | 20 | ~$40 |
| 1,000 | 12 | ~$240 |
| 10,000 | 8 | ~$1,600 |

> Import frequency drops over time as users build their library — new users import heavily, established users import occasionally. Factor a blended average.

### Total monthly operating cost

| Scale | Infrastructure | Claude API | **Total** |
|---|---|---|---|
| 100 users | $83 | $40 | **$123** |
| 1,000 users | $185 | $240 | **$425** |
| 10,000 users | $645 | $1,600 | **$2,245** |

---

## 4. Subscription Pricing

### Tier structure

| Tier | Monthly Price | Annual Price | Import Limit | Library | Features |
|---|---|---|---|---|---|
| **Free** | $0 | $0 | 5 imports/day, 20 total lifetime | 20 recipes | Import, view library |
| **Basic** | $3.99/mo | $35.99/yr | **10 imports/day** | 200 recipes | + Meal planner |
| **Pro** | $8.99/mo | $79.99/yr | **Unlimited** (fair-use) | Unlimited | + Shopping lists, diet AI, priority processing |

> **Basic import rationale**: 10/day is genuinely useful (a user can build a meaningful library over weeks) without enabling bulk abuse. A user importing 10 reels × 30 days = 300 recipes/month would hit the library cap well before the daily cap, so in practice the library limit is the real constraint.

### Unit economics at scale (1,000 paying users)

Assume mix: 60% Free, 30% Basic ($3.99), 10% Pro ($8.99)

| Segment | Users | MRR |
|---|---|---|
| Free | 600 | $0 |
| Basic | 300 | $1,197 |
| Pro | 100 | $899 |
| **Total** | **1,000** | **$2,096** |

Operating cost at 1,000 users: ~$425/month
**Gross margin: ~80%** — healthy for a SaaS at this scale.

### Stripe integration
- iOS: Apple In-App Purchase (required by Apple, 15–30% fee applies)
- Android: Google Play Billing (15–30% fee applies)
- Web: Stripe directly (2.9% + $0.30 per transaction)
- Offer annual plans on web to avoid app store fees on renewals where possible

---

## 5. Recommended Build Order

1. **Auth system** — Cognito or Auth0, JWT tokens, per-user data isolation
2. **Migrate SQLite → RDS PostgreSQL** — add `user_id` FK to all tables
3. **S3 for file storage** — thumbnails + video uploads go to S3, served via CloudFront
4. **Per-user job queue** — replace global in-memory tracker with SQS + DB-backed job records
5. **Implement subscription tiers** — enforce daily import limits + library caps per tier
6. **Privacy & compliance** — account deletion, data export, HTTPS (see `docs/engineering/compliance-implementation-plan.md`)
7. **Shift import model** — add video file upload; assess risk of keeping URL import
8. **App Store submission** — privacy policy URL, account deletion in-app, compliance review
