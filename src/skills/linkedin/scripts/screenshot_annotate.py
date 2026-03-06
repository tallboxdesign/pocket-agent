#!/usr/bin/env python3
"""
Screenshot & Annotate - Capture web pages and add visual annotations.

Usage:
    # Basic screenshot
    python screenshot_annotate.py --url "https://example.com" -o output.png

    # Screenshot a specific element
    python screenshot_annotate.py --url "https://example.com" --selector ".main-content" -o output.png

    # Screenshot with red rectangle annotations
    python screenshot_annotate.py --url "https://example.com" --annotations '[
        {"type": "rect", "selector": ".important-section", "color": "red", "label": "Key Finding"},
        {"type": "rect", "x": 100, "y": 200, "width": 300, "height": 50, "color": "#FF0000", "label": "1"}
    ]' -o output.png

    # Screenshot with arrow annotations
    python screenshot_annotate.py --url "https://example.com" --annotations '[
        {"type": "arrow", "from_selector": ".source", "to_selector": ".target", "color": "red"}
    ]' -o output.png

    # Render local HTML string as image (for tables, code blocks, etc.)
    python screenshot_annotate.py --html "<table><tr><td>Data</td></tr></table>" --css "table{border:1px solid}" -o output.png

    # Full page screenshot with scroll
    python screenshot_annotate.py --url "https://example.com" --full-page -o output.png

    # Viewport crop (capture specific region by pixel coords)
    python screenshot_annotate.py --url "https://example.com" --crop "100,200,800,600" -o output.png
"""

import argparse
import json
import sys
import time
import tempfile
from pathlib import Path

from patchright.sync_api import sync_playwright


def inject_annotations(page, annotations: list) -> None:
    """Inject CSS overlay annotations onto the page."""
    if not annotations:
        return

    # Build annotation overlay elements
    page.evaluate('''(annotations) => {
        // Create overlay container
        const container = document.createElement('div');
        container.id = '__annotations_overlay__';
        container.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;';
        document.body.appendChild(container);

        for (const ann of annotations) {
            let box = null;

            if (ann.selector) {
                const el = document.querySelector(ann.selector);
                if (el) box = el.getBoundingClientRect();
            } else if (ann.x !== undefined && ann.y !== undefined) {
                box = {
                    x: ann.x, y: ann.y,
                    width: ann.width || 100, height: ann.height || 40,
                    top: ann.y, left: ann.x
                };
            }

            if (!box) continue;

            const scrollX = window.scrollX;
            const scrollY = window.scrollY;
            const color = ann.color || 'red';
            const thickness = ann.thickness || 3;

            if (ann.type === 'rect' || !ann.type) {
                // Draw rectangle outline
                const rect = document.createElement('div');
                rect.style.cssText = `
                    position:absolute;
                    left:${box.x + scrollX - thickness}px;
                    top:${box.y + scrollY - thickness}px;
                    width:${box.width + thickness * 2}px;
                    height:${box.height + thickness * 2}px;
                    border:${thickness}px solid ${color};
                    border-radius:4px;
                    pointer-events:none;
                    box-sizing:border-box;
                `;
                container.appendChild(rect);

                // Add label if provided
                if (ann.label) {
                    const label = document.createElement('div');
                    label.textContent = ann.label;
                    label.style.cssText = `
                        position:absolute;
                        left:${box.x + scrollX - thickness}px;
                        top:${box.y + scrollY - 28}px;
                        background:${color};
                        color:white;
                        font-family:Arial,sans-serif;
                        font-size:13px;
                        font-weight:bold;
                        padding:2px 8px;
                        border-radius:3px 3px 0 0;
                        white-space:nowrap;
                        pointer-events:none;
                    `;
                    container.appendChild(label);
                }
            }

            if (ann.type === 'highlight') {
                // Semi-transparent highlight overlay
                const hl = document.createElement('div');
                hl.style.cssText = `
                    position:absolute;
                    left:${box.x + scrollX}px;
                    top:${box.y + scrollY}px;
                    width:${box.width}px;
                    height:${box.height}px;
                    background:${color};
                    opacity:0.25;
                    pointer-events:none;
                    border-radius:2px;
                `;
                container.appendChild(hl);
            }

            if (ann.type === 'number') {
                // Numbered circle callout
                const num = document.createElement('div');
                num.textContent = ann.label || '1';
                num.style.cssText = `
                    position:absolute;
                    left:${box.x + scrollX + box.width + 4}px;
                    top:${box.y + scrollY - 4}px;
                    width:28px;
                    height:28px;
                    background:${color};
                    color:white;
                    font-family:Arial,sans-serif;
                    font-size:14px;
                    font-weight:bold;
                    border-radius:50%;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    pointer-events:none;
                    box-shadow:0 2px 4px rgba(0,0,0,0.3);
                `;
                container.appendChild(num);
            }
        }
    }''', annotations)


def inject_arrow_annotations(page, annotations: list) -> None:
    """Inject SVG arrow annotations (separate pass for from/to selectors)."""
    arrows = [a for a in annotations if a.get('type') == 'arrow']
    if not arrows:
        return

    page.evaluate('''(arrows) => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999998;overflow:visible;';
        document.body.appendChild(svg);

        // Arrowhead marker
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', '__arrow_head__');
        marker.setAttribute('markerWidth', '10');
        marker.setAttribute('markerHeight', '7');
        marker.setAttribute('refX', '10');
        marker.setAttribute('refY', '3.5');
        marker.setAttribute('orient', 'auto');
        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', '0 0, 10 3.5, 0 7');
        polygon.setAttribute('fill', 'red');
        marker.appendChild(polygon);
        defs.appendChild(marker);
        svg.appendChild(defs);

        const scrollX = window.scrollX;
        const scrollY = window.scrollY;

        for (const arr of arrows) {
            let fromBox = null, toBox = null;
            if (arr.from_selector) {
                const el = document.querySelector(arr.from_selector);
                if (el) fromBox = el.getBoundingClientRect();
            }
            if (arr.to_selector) {
                const el = document.querySelector(arr.to_selector);
                if (el) toBox = el.getBoundingClientRect();
            }
            if (!fromBox || !toBox) continue;

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', fromBox.x + scrollX + fromBox.width / 2);
            line.setAttribute('y1', fromBox.y + scrollY + fromBox.height / 2);
            line.setAttribute('x2', toBox.x + scrollX + toBox.width / 2);
            line.setAttribute('y2', toBox.y + scrollY + toBox.height / 2);
            line.setAttribute('stroke', arr.color || 'red');
            line.setAttribute('stroke-width', arr.thickness || 3);
            line.setAttribute('marker-end', 'url(#__arrow_head__)');
            svg.appendChild(line);
        }
    }''', arrows)


def screenshot_url(url: str, output: str, selector: str = None,
                   annotations: list = None, full_page: bool = False,
                   crop: str = None, viewport_width: int = 1440,
                   viewport_height: int = 900, wait: int = 2,
                   scroll_to: str = None) -> str:
    """Screenshot a URL with optional annotations."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': viewport_width, 'height': viewport_height})
        page.goto(url, wait_until='networkidle', timeout=30000)
        time.sleep(wait)

        # Scroll to element if requested
        if scroll_to:
            page.evaluate(f'document.querySelector("{scroll_to}")?.scrollIntoView({{block:"center"}})')
            time.sleep(1)

        # Inject annotations
        if annotations:
            inject_annotations(page, annotations)
            inject_arrow_annotations(page, annotations)
            time.sleep(0.5)

        # Determine what to screenshot
        if selector:
            el = page.query_selector(selector)
            if not el:
                print(f"ERROR: Selector '{selector}' not found", file=sys.stderr)
                browser.close()
                sys.exit(1)
            el.screenshot(path=output)
        elif crop:
            parts = [int(x) for x in crop.split(',')]
            if len(parts) != 4:
                print("ERROR: --crop requires x,y,width,height", file=sys.stderr)
                sys.exit(1)
            page.screenshot(path=output, clip={'x': parts[0], 'y': parts[1],
                                               'width': parts[2], 'height': parts[3]})
        else:
            page.screenshot(path=output, full_page=full_page)

        browser.close()

    print(output)
    return output


def screenshot_html(html: str, css: str, output: str, annotations: list = None,
                    viewport_width: int = 1440, viewport_height: int = 900) -> str:
    """Render HTML string as an image - for tables, code blocks, custom visuals."""
    # Build a self-contained HTML page
    full_html = f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
body {{ margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: white; }}
{css or ''}
</style>
</head><body>
{html}
</body></html>"""

    with tempfile.NamedTemporaryFile(suffix='.html', mode='w', delete=False) as f:
        f.write(full_html)
        tmp_path = f.name

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': viewport_width, 'height': viewport_height})
        page.goto(f'file://{tmp_path}', wait_until='networkidle')
        time.sleep(0.5)

        if annotations:
            inject_annotations(page, annotations)
            time.sleep(0.3)

        # Auto-size: screenshot just the body content
        body_box = page.evaluate('''() => {
            const body = document.body;
            return { width: body.scrollWidth, height: body.scrollHeight };
        }''')
        page.set_viewport_size({'width': min(body_box['width'] + 48, viewport_width),
                                'height': min(body_box['height'] + 48, 4000)})
        time.sleep(0.3)
        page.screenshot(path=output, full_page=True)
        browser.close()

    Path(tmp_path).unlink(missing_ok=True)
    print(output)
    return output


def main():
    parser = argparse.ArgumentParser(description='Screenshot & Annotate web pages')
    parser.add_argument('--url', type=str, help='URL to screenshot')
    parser.add_argument('--html', type=str, help='HTML string to render as image')
    parser.add_argument('--html-file', type=str, help='HTML file to render as image')
    parser.add_argument('--css', type=str, default='', help='Extra CSS for --html mode')
    parser.add_argument('--selector', type=str, help='CSS selector to screenshot (element only)')
    parser.add_argument('--scroll-to', type=str, help='CSS selector to scroll to before screenshot')
    parser.add_argument('--annotations', type=str, help='JSON array of annotations')
    parser.add_argument('--annotations-file', type=str, help='JSON file with annotations')
    parser.add_argument('--full-page', action='store_true', help='Full page screenshot')
    parser.add_argument('--crop', type=str, help='Crop region: x,y,width,height')
    parser.add_argument('--width', type=int, default=1440, help='Viewport width')
    parser.add_argument('--height', type=int, default=900, help='Viewport height')
    parser.add_argument('--wait', type=int, default=2, help='Seconds to wait after load')
    parser.add_argument('-o', '--output', type=str, required=True, help='Output image path')
    args = parser.parse_args()

    # Parse annotations
    annotations = None
    if args.annotations:
        annotations = json.loads(args.annotations)
    elif args.annotations_file:
        annotations = json.loads(Path(args.annotations_file).read_text())

    if args.html or args.html_file:
        html = args.html or Path(args.html_file).read_text()
        screenshot_html(html, args.css, args.output, annotations=annotations,
                        viewport_width=args.width, viewport_height=args.height)
    elif args.url:
        screenshot_url(args.url, args.output, selector=args.selector,
                       annotations=annotations, full_page=args.full_page,
                       crop=args.crop, viewport_width=args.width,
                       viewport_height=args.height, wait=args.wait,
                       scroll_to=args.scroll_to)
    else:
        print("ERROR: Provide --url or --html or --html-file", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
