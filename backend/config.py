from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    anthropic_api_key: str
    database_url: str = "sqlite:///./recipereel.db"
    upload_dir: str = "./uploads"
    whisper_model: str = "small"  # tiny | base | small | medium | large
    github_token: str = ""        # GitHub PAT with repo scope (for public library writes)
    github_public_repo: str = "abdalziel/ReelRecipe-Public"

    # JWT auth (set a long random secret in production)
    jwt_secret: str = "dev-secret-change-this-in-production"

    # Admin — the account with this email gets is_admin=True automatically
    admin_email: str = ""

    # Cloudflare R2 storage (optional — falls back to local filesystem if not set)
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket_name: str = ""
    r2_public_url: str = ""  # e.g. https://pub-xxxx.r2.dev or custom domain

    class Config:
        env_file = ".env"


settings = Settings()
