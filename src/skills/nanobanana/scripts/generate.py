#!/usr/bin/env python3
"""
Planner-owned Nano Banana image generator with model selection and metadata stripping.
"""

import argparse
import io
import os
import sys
from pathlib import Path

try:
    from google import genai
    from google.genai import types
except ImportError:
    print("Error: google-genai package not installed.", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    Image = None

VALID_ASPECT_RATIOS = [
    "1:1", "2:3", "3:2", "3:4", "4:3",
    "4:5", "5:4", "9:16", "16:9", "21:9",
]

MODEL_ALIASES = {
    "nano-banana-2": "gemini-3.1-flash-image-preview",
    "nano-banana-pro": "gemini-3-pro-image-preview",
    "nano-banana-fast": "gemini-2.5-flash-image",
    "nano-banana": "gemini-3-pro-image-preview",
}


def get_api_key() -> str:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("Error: GEMINI_API_KEY environment variable not set.", file=sys.stderr)
        sys.exit(1)
    return api_key


def resolve_model(raw: str | None) -> str:
    normalized = (raw or "").strip()
    if not normalized:
        return MODEL_ALIASES["nano-banana-pro"]
    return MODEL_ALIASES.get(normalized, normalized)


def parse_bool(raw: str | None, default: bool = True) -> bool:
    if raw is None:
        return default
    normalized = str(raw).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def save_png_without_metadata(image_bytes: bytes, output_path: Path, strip_metadata: bool) -> str:
    if not strip_metadata:
        output_path.write_bytes(image_bytes)
        return "disabled"

    if Image is None:
        output_path.write_bytes(image_bytes)
        return "unavailable"

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            clean = img.convert("RGBA") if img.mode not in {"RGB", "RGBA"} else img.copy()
            clean.save(output_path, format="PNG")
        return "stripped"
    except Exception:
        output_path.write_bytes(image_bytes)
        return "fallback_raw"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate planner images with selectable Gemini image model.")
    parser.add_argument("prompt", help="Image prompt")
    parser.add_argument("-o", "--output", required=True, help="Output path")
    parser.add_argument("--model", default="nano-banana-pro", help="Model alias or raw Gemini image model")
    parser.add_argument("--ratio", choices=VALID_ASPECT_RATIOS, default="3:2", help="Aspect ratio")
    parser.add_argument("--strip-metadata", default="true", help="Whether to strip embedded PNG metadata")
    args = parser.parse_args()

    api_key = get_api_key()
    model_name = resolve_model(args.model)
    strip_metadata = parse_bool(args.strip_metadata, True)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        response_modalities=["IMAGE", "TEXT"],
        image_config=types.ImageConfig(aspect_ratio=args.ratio),
    )

    try:
        response = client.models.generate_content(
            model=model_name,
            contents=[args.prompt],
            config=config,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    image_bytes = None
    text_fallback = None
    for part in response.candidates[0].content.parts:
        if getattr(part, "inline_data", None) and getattr(part.inline_data, "mime_type", "").startswith("image/"):
            image_bytes = part.inline_data.data
        elif getattr(part, "text", None):
            text_fallback = part.text

    if not image_bytes:
        print(f"Error: {text_fallback or 'No image generated'}", file=sys.stderr)
        return 1

    strip_result = save_png_without_metadata(image_bytes, output_path, strip_metadata)
    print(f"strip_result={strip_result}", file=sys.stderr)
    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
