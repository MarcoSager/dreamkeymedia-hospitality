# Browser checks for the apply form. Run:
#   PORT=8788 node tests/dev-server.mjs &   then   python3 tests/client_test.py
# /api/lead responses are mocked per scenario; fbq and window.open are stubbed.
import json, os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:8788")
XSS_NAME = 'Test <img src=x onerror="window.__xss=1">'

INIT = """
window.__fbq = []; window.__opened = [];
window.fbq = function(){ window.__fbq.push(Array.from(arguments)); };
window.fbq.loaded = true;
window.open = function(u){ window.__opened.push(u); return null; };
"""


def setup(page, api_mode):
    calls = {"api": [], "formspree": 0}

    def api(route):
        calls["api"].append(json.loads(route.request.post_data or "{}"))
        if api_mode == "ok":
            route.fulfill(status=200, content_type="application/json", body='{"ok":true}')
        elif api_mode == "fail":
            route.fulfill(status=502, content_type="application/json", body='{"ok":false,"error":"x"}')
        else:
            route.abort()

    def formspree(route):
        calls["formspree"] += 1
        route.fulfill(status=200, body="{}")

    page.route("**/api/lead", api)
    page.route("**/formspree.io/**", formspree)
    for pat in ["**/connect.facebook.net/**", "**/googletagmanager.com/**",
                "**/challenges.cloudflare.com/**", "**/facebook.com/tr**"]:
        page.route(pat, lambda r: r.abort())
    page.add_init_script(INIT)
    return calls


def fill_form(page, name="Test Lead"):
    page.fill("#vp-name", name)
    page.fill("#vp-business", "Test Bar")
    page.fill("#vp-email", "dreamkeymediaasia@gmail.com")
    page.fill("#vp-phone", "+66970752722")
    page.click("text=Starter Package")
    page.click("text=ASAP")
    # Real Turnstile can't validate on localhost; inject a token like the widget would.
    page.evaluate("""() => {
      const i = document.createElement('input');
      i.type = 'hidden'; i.name = 'cf-turnstile-response'; i.value = 'XXXX.DUMMY.TOKEN.XXXX';
      document.getElementById('apply-form').appendChild(i);
    }""")


def lead_events(page):
    return [c for c in page.evaluate("window.__fbq") if c[:2] == ["track", "Lead"]]


results = []
def check(label, cond, detail=""):
    results.append((label, bool(cond), detail))


with sync_playwright() as p:
    browser = p.chromium.launch()

    # T1: API ok -> Lead fires once, WhatsApp opens with Source line, payload carries attribution
    ctx = browser.new_context(); page = ctx.new_page(); calls = setup(page, "ok")
    page.goto(BASE + "/?utm_source=facebook&utm_campaign=nov-test&fbclid=FB123")
    fill_form(page, XSS_NAME)
    page.click("#apply-form button[type=submit]")
    page.wait_for_timeout(800)
    payload = calls["api"][0] if calls["api"] else {}
    opened = page.evaluate("window.__opened")
    check("T1 API called once", len(calls["api"]) == 1, f"{len(calls['api'])} calls")
    check("T1 payload has utm/fbclid/source/token",
          payload.get("utm_campaign") == "nov-test" and payload.get("fbclid") == "FB123"
          and payload.get("source") == "form" and payload.get("cf-turnstile-response"))
    check("T1 Lead pixel fired once on ok", len(lead_events(page)) == 1, str(lead_events(page)))
    check("T1 WhatsApp opened with 'Source: nov-test'",
          len(opened) == 1 and "Source%3A%20nov-test" in opened[0])
    check("T1 Formspree copy sent", calls["formspree"] == 1)
    check("T1 name rendered as text, not HTML",
          page.evaluate("window.__xss") is None and page.evaluate("document.querySelectorAll('#apply-form img').length") == 0
          and "<img" in page.evaluate("document.querySelector('#apply-form h3').textContent"))
    ctx.close()

    # T2: API returns ok:false -> no Lead, WhatsApp + Formspree still fire
    ctx = browser.new_context(); page = ctx.new_page(); calls = setup(page, "fail")
    page.goto(BASE + "/")
    fill_form(page); page.click("#apply-form button[type=submit]"); page.wait_for_timeout(800)
    opened = page.evaluate("window.__opened")
    check("T2 GHL fail: no Lead pixel", len(lead_events(page)) == 0)
    check("T2 GHL fail: WhatsApp still opened", len(opened) == 1)
    check("T2 GHL fail: Formspree still sent", calls["formspree"] == 1)
    check("T2 direct visit -> 'Source: direct'", opened and "Source%3A%20direct" in opened[0])
    ctx.close()

    # T3: network error -> same guarantees
    ctx = browser.new_context(); page = ctx.new_page(); calls = setup(page, "abort")
    page.goto(BASE + "/")
    fill_form(page); page.click("#apply-form button[type=submit]"); page.wait_for_timeout(800)
    check("T3 network error: no Lead, WhatsApp opened",
          len(lead_events(page)) == 0 and len(page.evaluate("window.__opened")) == 1)
    ctx.close()

    # T4: double submit -> one API call, one WhatsApp
    ctx = browser.new_context(); page = ctx.new_page(); calls = setup(page, "ok")
    page.goto(BASE + "/")
    fill_form(page)
    page.evaluate("""() => { const f = document.getElementById('apply-form');
      f.requestSubmit(); f.requestSubmit(); }""")
    page.wait_for_timeout(800)
    check("T4 double submit: 1 API call, 1 WhatsApp",
          len(calls["api"]) == 1 and len(page.evaluate("window.__opened")) == 1,
          f"api={len(calls['api'])} opened={len(page.evaluate('window.__opened'))}")
    ctx.close()

    # T5: first touch wins within a session
    ctx = browser.new_context(); page = ctx.new_page(); setup(page, "ok")
    page.goto(BASE + "/?utm_source=first")
    page.goto(BASE + "/?utm_source=second")
    check("T5 first-touch utm kept", page.evaluate("sessionStorage.getItem('utm_source')") == "first")
    ctx.close()

    # T6: existing Contact / BookCallClick events still fire
    ctx = browser.new_context(); page = ctx.new_page(); setup(page, "ok")
    page.route("**/wa.me/**", lambda r: r.abort()); page.route("**/link.dreamkeymedia.net/widget/booking/**", lambda r: r.abort())
    page.goto(BASE + "/")
    page.evaluate("""() => {
      document.querySelector('a[href*="wa.me"]').addEventListener('click', e => e.preventDefault());
      document.querySelector('a[href*="/widget/booking/"]').addEventListener('click', e => e.preventDefault());
      document.querySelector('a[href*="wa.me"]').click();
      document.querySelector('a[href*="/widget/booking/"]').click();
    }""")
    ev = page.evaluate("window.__fbq")
    check("T6 Contact + BookCallClick still fire",
          ["track", "Contact", {"content_name": "WhatsApp"}] in ev and ["trackCustom", "BookCallClick"] in ev)
    ctx.close()

    # T7: mobile width, keyboard-only submit, no horizontal overflow
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = ctx.new_page(); calls = setup(page, "ok")
    page.goto(BASE + "/")
    overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check("T7 mobile: no horizontal overflow", overflow <= 0, f"overflow={overflow}px")
    page.focus("#vp-name"); page.keyboard.type("Keyboard User")
    page.keyboard.press("Tab"); page.keyboard.type("KB Bar")
    page.keyboard.press("Tab"); page.keyboard.type("dreamkeymediaasia@gmail.com")
    page.keyboard.press("Tab"); page.keyboard.type("+66970752722")
    page.focus("input[name=interest]"); page.keyboard.press("Space")
    page.evaluate("""() => { const i = document.createElement('input'); i.type='hidden';
      i.name='cf-turnstile-response'; i.value='XXXX.DUMMY.TOKEN.XXXX';
      document.getElementById('apply-form').appendChild(i); }""")
    page.focus("#apply-form button[type=submit]"); page.keyboard.press("Enter")
    page.wait_for_timeout(800)
    check("T7 keyboard-only submit works", len(calls["api"]) == 1 and calls["api"][0].get("name") == "Keyboard User")
    ctx.close()

    browser.close()

for label, ok, detail in results:
    print(("PASS " if ok else "FAIL ") + label + (f"  ({detail})" if detail and not ok else ""))
print(f"\n{sum(ok for _, ok, _ in results)}/{len(results)} passed")
