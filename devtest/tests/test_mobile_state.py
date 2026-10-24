"""Mobile UI state restoration checks using a deliberately mocked local state response.

This exercises the shipped HTML/JavaScript in fresh Chromium documents.  It
does not test normal browser networking, private-port authentication, Safari,
or iPhone sharing.
"""
import re
import unittest
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # The quality container may omit the optional UI runner.
    sync_playwright = None


ROOT = Path(__file__).resolve().parents[1]


def planned_state():
    return {
        "csrf": "test-csrf", "busy": False, "ready": False, "revision": 7,
        "clips": [], "upload": None, "feedback": {}, "receipt": None,
        "expiresIn": 3600, "status": "Review your moments.", "progress": 0,
        "limits": {"clips": 3, "bytesPerClip": 750 * 1024 * 1024, "secondsPerClip": 300},
        "directed": {
            "seconds": 45, "coverage": {"omitted": []},
            "plan": {
                "settings": {
                    "mode": "trailer", "style": "musicVideo", "targetSeconds": 300,
                    "transitions": "dissolves", "gentleCleanup": True,
                    "prompt": "Keep the chorus intact; use the stage-light reveal.",
                },
                "moments": [], "director": "Test direction.", "warnings": [],
            },
            "editorialProposal": {
                "metrics": {"before": {"adjacentSourceRepeats": 2}, "after": {"adjacentSourceRepeats": 0}},
                "transitions": [{"kind": "cut"}, {"kind": "dissolve"}],
                "notes": ["Review-only: no trim or lock has changed."], "conflicts": [],
            },
        },
    }


class MobileStateTests(unittest.TestCase):
    def test_source_binds_all_saved_edit_settings_to_visible_controls(self):
        """Regression contract when the optional browser runner is unavailable."""
        source = (ROOT / "static" / "app.js").read_text()
        markup = (ROOT / "static" / "index.html").read_text()
        for control in ("mode", "style", "length", "transitions", "prompt", "cleanup"):
            self.assertIn(control, source)
        self.assertIn("restoreSavedSettings(next.directed.plan.settings)", source)
        self.assertIn('id="savedSettings"', markup)
        self.assertIn('id="editorialProposal"', markup)
        self.assertIn('value="300"', markup)
        self.assertIn('data-target="300"', markup)
        self.assertIn('compilationApproved', source)
        self.assertIn('state.limits?.clips', source)
        self.assertIn('id="durationTruth"', markup)
        self.assertIn('function durationTruth(directed)', source)
        self.assertIn('Nothing is padded, looped, stretched, or invented.', source)
        self.assertIn('extend and lock an approved source moment', source)
        self.assertIn('AbortController', source)
        self.assertIn('Connection interrupted. Retrying observation', source)
        self.assertIn('statusSeconds', source)

    @unittest.skipUnless(sync_playwright, "Playwright is not installed in this quality container")
    def test_saved_visible_settings_restore_in_a_fresh_document(self):
        """A fresh UI document mirrors server-saved plan settings, not defaults."""
        html = (ROOT / "static" / "index.html").read_text()
        html = re.sub(r'<script[^>]+src="/app.js"[^>]*></script>', '', html)
        html = re.sub(r'<link[^>]+href="/style.css"[^>]*>', '', html)
        state = planned_state()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
                                                 args=["--no-sandbox"])
            for _ in range(2):  # Two independent documents reproduce a page reload.
                page = browser.new_page(viewport={"width": 390, "height": 844})
                page.set_content(html)
                page.add_style_tag(path=str(ROOT / "static" / "style.css"))
                page.evaluate("""state => {
                    window.fetch = async () => new Response(JSON.stringify(state), {
                      status: 200, headers: {"content-type": "application/json"}
                    });
                }""", state)
                page.add_script_tag(path=str(ROOT / "static" / "app.js"))
                page.wait_for_function("document.getElementById('review').hidden === false")
                self.assertEqual(page.locator("#mode").input_value(), "trailer")
                self.assertEqual(page.locator("#style").input_value(), "musicVideo")
                self.assertEqual(page.locator("#length").input_value(), "300")
                self.assertEqual(page.locator("#transitions").input_value(), "dissolves")
                self.assertTrue(page.locator("#cleanup").is_checked())
                self.assertEqual(page.locator("#prompt").input_value(), state["directed"]["plan"]["settings"]["prompt"])
                self.assertIn("Saved edit settings restored", page.locator("#savedSettings").inner_text())
                self.assertFalse(page.locator("#editorialProposal").is_hidden())
                # A closed <details> intentionally has no rendered innerText. Verify
                # its supplied content, then open it before asserting visible copy.
                self.assertIn("Review-only suggestion", page.locator("#editorialProposalSummary").text_content())
                page.locator("#editorialProposal summary").click()
                self.assertIn("Review-only suggestion", page.locator("#editorialProposalSummary").inner_text())
                self.assertIn("no trim or lock has changed", page.locator("#editorialProposalDetail").inner_text())
                page.close()
            browser.close()

    @unittest.skipUnless(sync_playwright, "Playwright is not installed in this quality container")
    def test_clear_dialog_requires_confirm_and_escape_or_cancel_do_not_mutate(self):
        """The private browser path must not depend on native confirm()."""
        html = (ROOT / "static" / "index.html").read_text()
        html = re.sub(r'<script[^>]+src="/app.js"[^>]*></script>', '', html)
        html = re.sub(r'<link[^>]+href="/style.css"[^>]*>', '', html)
        state = planned_state()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
                                                 args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 390, "height": 844})
            page.set_content(html)
            page.add_style_tag(path=str(ROOT / "static" / "style.css"))
            page.evaluate("""state => {
                window.clearCalls = [];
                window.fetch = async (url, options = {}) => {
                    if (url === '/api/clear') window.clearCalls.push({url, method: options.method, csrf: options.headers?.['X-Compass-CSRF']});
                    return new Response(JSON.stringify(url === '/api/clear' ? {ok: true} : state), {
                        status: 200, headers: {"content-type": "application/json"}
                    });
                };
            }""", state)
            page.add_script_tag(path=str(ROOT / "static" / "app.js"))
            page.wait_for_function("document.getElementById('review').hidden === false")
            page.locator("#clear").click()
            self.assertTrue(page.locator("#clearConfirm").evaluate("dialog => dialog.open"))
            page.keyboard.press("Escape")
            page.wait_for_function("!document.getElementById('clearConfirm').open")
            self.assertEqual(page.evaluate("window.clearCalls.length"), 0)
            page.locator("#clear").click(); page.locator("#clearCancel").click()
            self.assertEqual(page.evaluate("window.clearCalls.length"), 0)
            page.locator("#clear").click(); page.locator("#clearConfirmButton").click()
            page.wait_for_function("window.clearCalls.length === 1")
            self.assertEqual(page.evaluate("window.clearCalls[0].method"), "POST")
            self.assertEqual(page.evaluate("window.clearCalls[0].csrf"), "test-csrf")
            page.close(); browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
