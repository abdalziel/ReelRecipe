"""
Web recipe scraping service.

Tries recipe-scrapers (schema.org structured data, supports 300+ sites) first.
Falls back to extracting page text and passing it to Claude.

Also provides a page scanner that finds recipe links on a listing/index page.
"""
import json
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

try:
    from recipe_scrapers import scrape_html as rs_scrape_html
    SCRAPERS_AVAILABLE = True
except ImportError:
    SCRAPERS_AVAILABLE = False

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

# URL fragments that strongly suggest a link leads to a single recipe page
_RECIPE_URL_PATTERNS = [
    "/recipe/", "/recipes/", "-recipe", "recipe-",
    "/dish/", "/food/", "/cook/",
]


async def _fetch(url: str, timeout: int = 15) -> str:
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=timeout, headers=_HEADERS
    ) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.text


async def get_recipe_content(url: str) -> dict:
    """
    Fetch a recipe page and return content ready for Claude to structure.

    Returns:
        {
          "title": str,
          "ingredients": list[str],   # raw strings, may be empty
          "instructions": str,
          "image": str | None,
          "source": "structured" | "html"
        }
    Raises httpx.HTTPError or ValueError on failure.
    """
    html = await _fetch(url)

    # ── Try structured scraper first ──────────────────────────────────────
    if SCRAPERS_AVAILABLE:
        try:
            scraper = rs_scrape_html(html, org_url=url)
            title = scraper.title() or ""
            ings = scraper.ingredients() or []
            instructions = scraper.instructions() or ""
            if title and (ings or instructions):
                return {
                    "title": title,
                    "ingredients": ings,
                    "instructions": instructions,
                    "image": scraper.image() if hasattr(scraper, "image") else None,
                    "source": "structured",
                }
        except Exception:
            pass

    # ── Fall back: strip HTML to readable text for Claude ─────────────────
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "iframe"]):
        tag.decompose()

    # Try to find a title
    title = ""
    h1 = soup.find("h1")
    if h1:
        title = h1.get_text(strip=True)

    # Find the first large image (likely the recipe photo)
    image = None
    for img in soup.find_all("img", src=True):
        src = img["src"]
        if any(ext in src.lower() for ext in (".jpg", ".jpeg", ".png", ".webp")):
            image = urljoin(url, src)
            break

    text = soup.get_text(separator="\n", strip=True)
    text = text[:5000]  # keep token cost reasonable

    return {
        "title": title,
        "ingredients": [],
        "instructions": text,
        "image": image,
        "source": "html",
    }


async def find_recipes_on_page(page_url: str) -> list[dict]:
    """
    Scan a web page and return a list of recipe links found on it.

    Returns up to 60 items: [{"url": str, "title": str}]
    """
    html = await _fetch(page_url)
    soup = BeautifulSoup(html, "html.parser")
    base_domain = urlparse(page_url).netloc
    found: dict[str, str] = {}  # url → title

    # ── schema.org ItemList (recipe collections, search results) ──────────
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
            if isinstance(data, list):
                data = data[0]
            if data.get("@type") == "ItemList":
                for item in data.get("itemListElement", []):
                    inner = item.get("item") or item
                    item_url = inner.get("url") or item.get("url")
                    item_name = inner.get("name") or item.get("name") or ""
                    if item_url:
                        found[urljoin(page_url, item_url)] = item_name
        except Exception:
            pass

    # ── Anchor tags with recipe-like URLs on the same domain ──────────────
    for a in soup.find_all("a", href=True):
        href: str = a["href"]
        abs_url = urljoin(page_url, href)
        if urlparse(abs_url).netloc != base_domain:
            continue
        if any(p in href.lower() for p in _RECIPE_URL_PATTERNS):
            title = a.get_text(strip=True)
            if 5 < len(title) < 120:
                found.setdefault(abs_url, title)

    return [{"url": u, "title": t} for u, t in found.items()][:60]
