# ReelRecipe — Compliance Implementation Plan

This document defines the technical implementation for four compliance requirements:
1. In-app account deletion flow
2. Data export endpoints (GDPR Article 20)
3. HTTPS everywhere
4. Data encryption at rest

Each section covers what to build, why it's required, and the exact implementation steps.

---

## 1. In-App Account Deletion Flow

### Why it's required
- **Apple App Store (2022 requirement)**: Apps with account creation must offer in-app account deletion. Apps that don't comply are rejected at review.
- **Google Play**: Same requirement as of May 2024.
- **GDPR Article 17**: "Right to erasure" — users can request deletion of their personal data.

### What must be deleted
| Data | Storage Location | Action |
|---|---|---|
| User record (email, hashed password, name) | RDS `users` table | Hard delete |
| All recipes | RDS `recipes`, `ingredients`, `recipe_ingredients` | Hard delete (cascade) |
| Meal plans | RDS `meal_plans`, `meal_plan_entries` | Hard delete (cascade) |
| Shopping lists | RDS `shopping_lists`, `shopping_list_items` | Hard delete (cascade) |
| Diet plan | RDS `diet_plans` | Hard delete |
| Thumbnails and uploads | S3 bucket | Delete all objects under `users/{user_id}/` |
| Sessions / JWT refresh tokens | Redis or DB sessions table | Invalidate immediately |
| Import job state | SQS + DB jobs table | Cancel any queued jobs, delete records |
| Billing record link | Stripe | Cancel subscription; retain Stripe's own records per tax law |

**Billing records** (Stripe invoices, payment history): do NOT delete from Stripe — these are required for tax and accounting purposes for 7 years. Sever the link between the Stripe customer ID and the user's email in your own DB (set `stripe_customer_id = NULL`, store the anonymized Stripe ID separately if needed for refund disputes).

### Deletion timeline
- **Immediate**: sessions invalidated, user cannot log in, import jobs cancelled
- **Within 30 days**: all personal data and files deleted from production systems
- **Confirm via email**: send a confirmation email before beginning deletion ("Your account will be deleted within 30 days. If this was a mistake, contact us within 7 days.")

### Backend implementation

```python
# POST /api/account/delete
# Requires authentication + password confirmation

async def delete_account(user_id: int, password: str, db: Session):
    # 1. Verify password before deletion
    user = db.query(User).filter(User.id == user_id).first()
    if not verify_password(password, user.hashed_password):
        raise HTTPException(400, "Incorrect password")

    # 2. Schedule deletion (soft-delete first, hard-delete async)
    user.deletion_requested_at = datetime.utcnow()
    user.is_active = False
    db.commit()

    # 3. Immediately invalidate all sessions
    db.query(UserSession).filter(UserSession.user_id == user_id).delete()
    db.commit()

    # 4. Cancel Stripe subscription if active
    if user.stripe_subscription_id:
        stripe.Subscription.cancel(user.stripe_subscription_id)

    # 5. Send confirmation email
    await send_deletion_confirmation_email(user.email)

    # 6. Queue async hard-delete job (runs within 30 days, or immediately)
    await queue_hard_delete_job(user_id)
```

```python
# Hard delete job (runs async, e.g. via Celery/SQS worker)
async def hard_delete_user(user_id: int, db: Session):
    # Delete S3 files
    s3.delete_objects(Bucket=BUCKET, Objects=[
        {"Key": key} for key in list_user_s3_objects(user_id)
    ])

    # Cascade delete in DB (FK constraints handle cascade if set up correctly)
    db.query(User).filter(User.id == user_id).delete()
    db.commit()
```

### Mobile UI flow

```
Settings
  └── Account
        └── Delete Account
              ├── Warning screen: "This will permanently delete all your recipes,
              │   meal plans, and account data. This cannot be undone."
              ├── [Export my data first] → triggers data export (see Section 2)
              ├── Password confirmation input
              └── [Confirm Delete] → POST /api/account/delete
                    └── Success: log out, show "Account deletion requested.
                        You'll receive a confirmation email."
```

### Testing checklist
- [ ] Cannot log in after deletion is requested
- [ ] Confirmation email sent within 5 minutes
- [ ] All recipes absent from DB within 30 days
- [ ] S3 objects deleted within 30 days
- [ ] Stripe subscription cancelled
- [ ] Attempt to use exported JWT after deletion returns 401

---

## 2. Data Export Endpoints (GDPR Article 20)

### Why it's required
- **GDPR Article 20**: "Right to data portability" — users must be able to receive their personal data in a "structured, commonly used, machine-readable format."
- **Good practice for all users**: also required by Apple/Google review guidelines in some regions.
- **Practical benefit**: offering export before account deletion reduces friction and support requests.

### What to include in the export

```
export_<user_id>_<date>.zip
├── account.json          ← email, name, created_at, subscription tier
├── recipes.json          ← full recipe library (all fields)
├── recipes.csv           ← tabular version (title, ingredients, macros)
├── meal_plans.json       ← all meal plan entries
├── shopping_lists.json   ← all shopping lists
├── diet_plan.json        ← diet goals and targets
└── thumbnails/           ← all recipe thumbnail images
    ├── <shortcode>.jpg
    └── ...
```

### Backend implementation

```python
# GET /api/account/export
# Returns a download URL (S3 pre-signed URL) or streams the ZIP

import zipfile
import json
import io

async def export_user_data(user_id: int, db: Session) -> str:
    user = db.query(User).filter(User.id == user_id).first()
    recipes = db.query(Recipe).filter(Recipe.user_id == user_id).all()
    meal_plans = db.query(MealPlan).filter(MealPlan.user_id == user_id).all()
    shopping_lists = db.query(ShoppingList).filter(ShoppingList.user_id == user_id).all()
    diet_plan = db.query(DietPlan).filter(DietPlan.user_id == user_id).first()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        # account.json
        zf.writestr("account.json", json.dumps({
            "email": user.email,
            "created_at": user.created_at.isoformat(),
            "subscription_tier": user.subscription_tier,
        }, indent=2))

        # recipes.json
        zf.writestr("recipes.json", json.dumps(
            [recipe_to_dict(r) for r in recipes], indent=2
        ))

        # recipes.csv
        zf.writestr("recipes.csv", recipes_to_csv(recipes))

        # meal_plans.json
        zf.writestr("meal_plans.json", json.dumps(
            [meal_plan_to_dict(mp) for mp in meal_plans], indent=2
        ))

        # shopping_lists.json
        zf.writestr("shopping_lists.json", json.dumps(
            [shopping_list_to_dict(sl) for sl in shopping_lists], indent=2
        ))

        # diet_plan.json
        if diet_plan:
            zf.writestr("diet_plan.json", json.dumps(
                diet_plan_to_dict(diet_plan), indent=2
            ))

        # thumbnails
        for recipe in recipes:
            if recipe.thumbnail_url:
                img_bytes = fetch_s3_object(recipe.thumbnail_url)
                zf.writestr(f"thumbnails/{recipe.id}.jpg", img_bytes)

    buf.seek(0)

    # Upload to S3 with a short-lived pre-signed URL (expires in 1 hour)
    key = f"exports/{user_id}/export_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.zip"
    s3.put_object(Bucket=EXPORTS_BUCKET, Key=key, Body=buf.read(),
                  ServerSideEncryption="AES256")
    url = s3.generate_presigned_url("get_object",
        Params={"Bucket": EXPORTS_BUCKET, "Key": key},
        ExpiresIn=3600)

    # Clean up export file after 24 hours (S3 lifecycle rule)
    return url
```

### Mobile UI flow

```
Settings
  └── Account
        └── Export My Data
              ├── "Preparing your export… This may take a minute."
              └── [Download Export] → opens pre-signed URL in browser
                    → ZIP file downloads to device
```

### Performance note
For users with large libraries (500+ recipes with thumbnails), generating the export may take 30–60 seconds. Use a background job: user receives an email with the download link rather than waiting in-app.

### Export expiry
Pre-signed download URLs expire after 1 hour. The export file itself is deleted from S3 after 24 hours via a lifecycle policy.

### Testing checklist
- [ ] Export ZIP contains all user recipes, plans, lists
- [ ] Thumbnails are included
- [ ] CSV is valid and opens in Excel/Numbers
- [ ] Pre-signed URL expires after 1 hour
- [ ] Export file deleted from S3 after 24 hours
- [ ] Export for user with 0 recipes works without error
- [ ] Export is not accessible by another user's token

---

## 3. HTTPS Everywhere

### Why it's required
- **App Store / Play Store**: Both require HTTPS for all network requests from published apps.
- **Security baseline**: Prevents man-in-the-middle attacks on user credentials and health data.
- **GDPR Article 32**: Requires "appropriate technical measures" including encryption in transit.

### Implementation on AWS

#### Certificate provisioning (AWS Certificate Manager)
```
1. Request a public certificate in ACM for reelrecipe.com and *.reelrecipe.com
2. Validate via DNS (add CNAME records in Route 53 — ACM auto-renews)
3. Attach certificate to:
   - Application Load Balancer (ALB) — HTTPS listener on port 443
   - CloudFront distribution — for S3 static assets and thumbnails
```

#### ALB configuration
```
Listener: HTTPS :443  →  Forward to ECS target group
Listener: HTTP :80    →  Redirect to HTTPS (301 permanent)

Security Policy: ELBSecurityPolicy-TLS13-1-2-2021-06
(supports TLS 1.2 and 1.3, rejects older versions)
```

#### HTTP Strict Transport Security (HSTS)
Add to FastAPI middleware:
```python
from starlette.middleware.httpsredirect import HTTPSRedirectMiddleware

app.add_middleware(HTTPSRedirectMiddleware)

@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Strict-Transport-Security"] = (
        "max-age=31536000; includeSubDomains; preload"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response
```

#### Mobile app — pin to HTTPS
In `mobile/.env`:
```
EXPO_PUBLIC_API_URL=https://api.reelrecipe.com
```

Ensure no HTTP fallback exists in `lib/api.ts`.

#### CloudFront for S3 assets
```
- S3 bucket: NOT publicly accessible (bucket policy blocks direct access)
- CloudFront origin: S3 via Origin Access Control (OAC)
- CloudFront → HTTPS only (redirect HTTP to HTTPS)
- Custom domain: cdn.reelrecipe.com with ACM cert
```

### Testing checklist
- [ ] HTTP requests redirect to HTTPS (301)
- [ ] TLS 1.2+ only (test with SSL Labs: ssllabs.com/ssltest)
- [ ] HSTS header present on all responses
- [ ] S3 bucket is NOT publicly accessible without CloudFront
- [ ] Mobile app never makes HTTP requests (verify with network proxy in testing)
- [ ] Certificate auto-renewal is confirmed in ACM
- [ ] Mixed content warnings absent on web dashboard

---

## 4. Data Encryption at Rest

### Why it's required
- **GDPR Article 32**: Requires "encryption of personal data" as a technical measure.
- **Diet/health data sensitivity**: Macro targets, caloric goals, and dietary restrictions qualify as health-adjacent data and warrant stronger protection.
- **App Store / Play Store privacy labels**: Declaring that health data is encrypted at rest supports accurate privacy nutrition labels.

### RDS PostgreSQL — encryption at rest

**Enable at creation time** (cannot be enabled on an existing unencrypted instance without a snapshot restore):

```
AWS Console → RDS → Create database
  ├── Encryption: Enable encryption ✓
  └── AWS KMS key: aws/rds (default) or create a customer-managed key (CMK)
```

With a Customer Managed Key (CMK):
```
AWS KMS → Create key
  ├── Type: Symmetric
  ├── Usage: Encrypt and decrypt
  ├── Alias: reelrecipe/rds
  └── Key policy: grant access to RDS service role and your deployment role
```

**What this covers**: All data in the database, automated backups, snapshots, and read replicas are encrypted using AES-256.

**What this does NOT cover**: Data in application memory. Sensitive fields (e.g., diet goals) can additionally be encrypted at the application layer if desired:

```python
from cryptography.fernet import Fernet

# Store ENCRYPTION_KEY in AWS Secrets Manager
fernet = Fernet(settings.field_encryption_key)

# Before saving diet plan text
plan.goals_encrypted = fernet.encrypt(goals_text.encode()).decode()

# On retrieval
goals_text = fernet.decrypt(plan.goals_encrypted.encode()).decode()
```

### S3 — encryption at rest

Enable default encryption on the bucket:
```
S3 → Bucket → Properties → Default encryption
  ├── Encryption type: SSE-S3 (AES-256, managed by AWS)
  └── OR: SSE-KMS with the same CMK used for RDS
```

Enforce encryption on all PUT operations via bucket policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::reelrecipe-uploads/*",
    "Condition": {
      "StringNotEquals": {
        "s3:x-amz-server-side-encryption": "AES256"
      }
    }
  }]
}
```

### Secrets — AWS Secrets Manager

All sensitive configuration values must be stored in Secrets Manager, not in environment files:

| Secret | Value |
|---|---|
| `reelrecipe/anthropic-api-key` | Claude API key |
| `reelrecipe/db-credentials` | DB host, port, username, password |
| `reelrecipe/jwt-secret` | JWT signing secret |
| `reelrecipe/field-encryption-key` | Application-layer Fernet key |
| `reelrecipe/stripe-secret-key` | Stripe API key |

Access in Python:
```python
import boto3, json

def get_secret(secret_name: str) -> dict:
    client = boto3.client("secretsmanager", region_name="us-east-1")
    response = client.get_secret_value(SecretId=secret_name)
    return json.loads(response["SecretString"])
```

### ECS task role
Fargate tasks must have an IAM role that grants read-only access to the specific secrets they need:
```json
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue"],
  "Resource": [
    "arn:aws:secretsmanager:*:*:secret:reelrecipe/*"
  ]
}
```

### Testing checklist
- [ ] RDS instance shows "Encryption: Enabled" in AWS console
- [ ] S3 bucket shows "Default encryption: SSE-S3 or SSE-KMS" enabled
- [ ] S3 PUT without encryption header returns 403
- [ ] All secrets loaded from Secrets Manager (no secrets in `.env` in production)
- [ ] ECS task role has minimal required permissions (principle of least privilege)
- [ ] Snapshots and RDS backups are also encrypted (automatic when RDS encryption is on)
- [ ] No sensitive values in CloudWatch logs (mask in application layer)

---

## Summary — Implementation Priority Order

| Priority | Item | Blocking? |
|---|---|---|
| 1 | HTTPS everywhere (ALB + ACM + redirect) | App Store submission |
| 2 | RDS + S3 encryption at rest | App Store privacy label; GDPR |
| 3 | Secrets Manager (no `.env` in production) | Security baseline |
| 4 | In-app account deletion flow | App Store requirement (hard block) |
| 5 | Data export endpoint | GDPR requirement; supports deletion flow |
| 6 | Application-layer field encryption (diet data) | GDPR best practice |
