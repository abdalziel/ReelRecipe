from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    anthropic_api_key: str
    database_url: str = "sqlite:///./recipereel.db"
    upload_dir: str = "./uploads"
    whisper_model: str = "small"  # tiny | base | small | medium | large
    github_token: str = ""        # GitHub PAT with repo scope (for public library writes)
    github_public_repo: str = "abdalziel/ReelRecipe-Public"

    class Config:
        env_file = ".env"


settings = Settings()
