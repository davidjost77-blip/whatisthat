/* Bankanbindung (Enable Banking) im Bereich „Import“: einrichten, Konto verbinden, abrufen, trennen.
   Nutzt api(), toast(), esc(), $ aus app.js. */
"use strict";
(function () {
  const COUNTRIES = [["DE", "Deutschland"], ["AT", "Österreich"], ["NL", "Niederlande"], ["FR", "Frankreich"], ["ES", "Spanien"],
    ["IT", "Italien"], ["BE", "Belgien"], ["LU", "Luxemburg"], ["FI", "Finnland"], ["SE", "Schweden"]];
  let st = null, banks = [], country = "DE", editing = false, busy = false;
  const redirectUrl = () => `https://localhost:${location.port || 8765}/bank/callback`;
  const mask = (iban) => (iban && iban.length > 8 ? `${iban.slice(0, 4)} … ${iban.slice(-4)}` : iban || "");
  const when = (iso) => (iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: iso.length > 10 ? "short" : undefined }) : "–");
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString("de-DE", { dateStyle: "medium" }) : "–");

  async function render() {
    const root = $("#bank");
    if (!root) return;
    try { st = await api("GET", "/api/bank"); } catch (e) { root.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; return; }
    root.innerHTML = `<div class="bank-head"><h2>Bankanbindung</h2><span class="muted">über Enable Banking · Lesezugriff, PSD2</span></div>
      ${!st.configured || editing ? setupHtml() : connectedHtml()}`;
    wire(root);
  }

  function setupHtml() {
    return `<p>Holt neue Buchungen direkt von deiner Bank – automatisch alle 6 Stunden. Deine Zugangsdaten gibst du nur bei
      deiner Bank ein; weder diese App noch Enable Banking sehen sie. Einmalige Einrichtung (ca. 10 Minuten, kostenlos):</p>
      <ol class="bank-steps">
        <li>Bei <a href="https://enablebanking.com/sign-in/" target="_blank" rel="noopener">enablebanking.com</a> kostenlos registrieren und im
          <b>Control Panel</b> eine neue Anwendung anlegen: Umgebung <b>Production</b>, Name z. B. „Finanzen“.</li>
        <li>Als <b>Redirect URL</b> eintragen: <code class="copy" data-copy="${esc(redirectUrl())}" title="Klicken zum Kopieren">${esc(redirectUrl())}</code></li>
        <li>Den Schlüssel im Browser erzeugen lassen – die Datei <code>….pem</code> wird heruntergeladen. Gut aufheben.</li>
        <li>Anwendung aktivieren mit <b>„Activate by linking accounts“</b> und dort deine eigenen Konten verknüpfen
          (kostenloser, eingeschränkter Modus: nur deine Konten).</li>
        <li>Hier die <b>Application-ID</b> eintragen und die <code>.pem</code>-Datei auswählen:</li>
      </ol>
      <form class="bank-form" id="bank-config">
        <label>Application-ID <input name="app_id" required value="${esc(st.app_id || "")}" placeholder="z. B. 3f1c…-…" autocomplete="off"></label>
        <label>Privater Schlüssel (.pem) <input name="key" type="file" accept=".pem,.key,.txt" ${st.configured ? "" : "required"}></label>
        <p class="muted small">Der Schlüssel wird nur lokal unter <code>data/bank/</code> gespeichert (nicht im Git-Repo).</p>
        <p class="form-error" id="bank-error"></p>
        <div class="btn-row"><button class="primary" type="submit">Speichern &amp; prüfen</button>
          ${st.configured ? `<button type="button" class="ghost" id="bank-cancel">Abbrechen</button>` : ""}</div>
      </form>`;
  }

  function sessionHtml(s) {
    const r = s.last_result;
    const expired = s.status !== "aktiv";
    return `<div class="bank-session ${expired ? "expired" : ""}">
      <div class="row"><b>${esc(s.aspsp)}</b>
        <span class="badge ${expired ? "bad" : ""}">${expired ? "⚠ Freigabe abgelaufen" : `gültig bis ${day(s.valid_until)}`}</span></div>
      <ul class="bank-accounts">${s.accounts.map((a) => `<li>${esc(a.name || "Konto")} <span class="muted">${esc(mask(a.iban))}</span></li>`).join("")}</ul>
      <div class="meta">Zuletzt abgerufen: ${when(s.last_sync)}${r ? ` · ${r.error ? `<span class="sig-bad">⚠ ${esc(r.error)}</span>` : `${r.new} neu${r.duplicate ? `, ${r.duplicate} schon vorhanden` : ""}`}` : ""}</div>
      <div class="btn-row">
        ${expired ? `<button class="primary" data-renew="${esc(s.aspsp)}" data-country="${esc(s.country)}">Neu freigeben</button>`
          : `<button data-sync="${esc(s.id)}">Jetzt abrufen</button>`}
        <button class="ghost" data-disconnect="${esc(s.id)}">Trennen</button>
      </div></div>`;
  }

  function connectedHtml() {
    const pending = st.pending;
    return `${st.sessions.map(sessionHtml).join("") || `<p class="empty-note">Noch keine Bank verbunden.</p>`}
      <div class="bank-connect">
        <h3>${st.sessions.length ? "Weitere Bank verbinden" : "Bank verbinden"}</h3>
        <div class="bank-pick">
          <select id="bank-country" aria-label="Land">${COUNTRIES.map(([k, n]) => `<option value="${k}" ${k === country ? "selected" : ""}>${n}</option>`).join("")}</select>
          <input id="bank-search" list="bank-list" placeholder="Bank suchen, z. B. DKB, ING, Sparkasse …" autocomplete="off">
          <datalist id="bank-list">${banks.map((b) => `<option value="${esc(b.name)}"></option>`).join("")}</datalist>
          <button class="primary" id="bank-login">Bei Bank anmelden</button>
        </div>
        ${pending ? `<div class="bank-finish">
          <p><b>Fast fertig:</b> Nach der Anmeldung bei <b>${esc(pending.aspsp)}</b> landet dein Browser auf einer Seite, die nicht lädt
            (<code>${esc(redirectUrl())}?…</code>) – das ist so gewollt. Kopiere die <b>komplette Adresse</b> aus der Adresszeile und füge sie hier ein:</p>
          <div class="bank-pick"><input id="bank-url" placeholder="https://localhost:…/bank/callback?state=…&code=…" autocomplete="off">
            <button class="primary" id="bank-finish">Verbindung abschließen</button></div></div>` : ""}
      </div>
      <label class="inline bank-auto"><input type="checkbox" id="bank-auto" ${st.auto ? "checked" : ""}>
        Automatisch alle ${st.interval_hours} Stunden abrufen <span class="muted">(PSD2 erlaubt 4 Abrufe am Tag ohne dich)</span></label>
      <p class="muted small">Anwendung: ${esc(st.application?.name || st.app_id)} · <a href="#import" id="bank-edit">Einrichtung ändern</a></p>`;
  }

  async function loadBanks() {
    try { banks = (await api("GET", `/api/bank/aspsps?country=${country}`)).aspsps; }
    catch (e) { banks = []; toast(`Bankenliste nicht abrufbar: ${e.message}`, { error: true }); }
    const dl = $("#bank-list");
    if (dl) dl.innerHTML = banks.map((b) => `<option value="${esc(b.name)}"></option>`).join("");
  }

  async function guard(btn, fn) {
    if (busy) return;
    busy = true;
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Moment …"; }
    try { await fn(); } catch (e) { toast(e.message, { error: true, timeout: 9000 }); }
    finally { busy = false; if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
  }

  async function login(name, ctry, btn) {
    const b = banks.find((x) => x.name.toLowerCase() === (name || "").trim().toLowerCase());
    if (!name?.trim()) return toast("Bitte zuerst eine Bank auswählen.", { error: true });
    await guard(btn, async () => {
      const res = await api("POST", "/api/bank/auth", { aspsp: b ? b.name : name.trim(), country: ctry, max_days: b?.max_days });
      window.open(res.url, "_blank", "noopener");
      await render();
      $("#bank-url")?.focus();
    });
  }

  function wire(root) {
    root.querySelectorAll(".copy").forEach((c) => (c.onclick = () => navigator.clipboard?.writeText(c.dataset.copy).then(() => toast("Kopiert"))));
    const form = $("#bank-config");
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        guard(form.querySelector("button[type=submit]"), async () => {
          const file = form.key.files[0];
          const key_pem = file ? await file.text() : null;
          try {
            const res = await api("PUT", "/api/bank/config", { app_id: form.app_id.value, key_pem });
            editing = false;
            toast(`Verbunden mit Enable Banking – Anwendung „${res.application?.name || "?"}“`);
            if (!(res.application?.redirect_urls || []).length) toast("In der Anwendung fehlt noch die Redirect URL.", { error: true, timeout: 9000 });
            await render();
            loadBanks();
          } catch (err) { $("#bank-error").textContent = err.message; throw err; }
        });
      };
      $("#bank-cancel") && ($("#bank-cancel").onclick = () => { editing = false; render(); });
      return;
    }
    if (!banks.length) loadBanks();
    $("#bank-country").onchange = (e) => { country = e.target.value; loadBanks(); };
    $("#bank-login").onclick = (e) => login($("#bank-search").value, country, e.target);
    $("#bank-search").onkeydown = (e) => { if (e.key === "Enter") login(e.target.value, country, $("#bank-login")); };
    const finish = $("#bank-finish");
    if (finish) finish.onclick = () => guard(finish, async () => {
      const res = await api("POST", "/api/bank/session", { url: $("#bank-url").value });
      const s = res.sync?.[0];
      toast(`${res.accounts.length} Konto${res.accounts.length === 1 ? "" : "en"} verbunden${s ? ` – ${s.new} Buchungen übernommen` : ""}`);
      await render();
      await loadStatus();
      loadImportView();
    });
    root.querySelectorAll("[data-sync]").forEach((b) => (b.onclick = () => guard(b, async () => {
      const r = (await api("POST", "/api/bank/sync", { session_id: b.dataset.sync })).results[0];
      toast(r?.error ? `Abruf fehlgeschlagen: ${r.error}` : `${r?.new || 0} neue Buchungen`, { error: !!r?.error });
      await render();
      await loadStatus();
    })));
    root.querySelectorAll("[data-renew]").forEach((b) => (b.onclick = () => login(b.dataset.renew, b.dataset.country, b)));
    root.querySelectorAll("[data-disconnect]").forEach((b) => (b.onclick = () => {
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Wirklich trennen? (Buchungen bleiben)"; return; }
      guard(b, async () => { await api("POST", "/api/bank/disconnect", { session_id: b.dataset.disconnect }); toast("Bank getrennt"); await render(); });
    }));
    $("#bank-auto").onchange = (e) => api("PUT", "/api/bank/settings", { auto: e.target.checked }).then(() => toast(e.target.checked ? "Automatischer Abruf an" : "Automatischer Abruf aus"));
    $("#bank-edit").onclick = (e) => { e.preventDefault(); editing = true; render(); };
  }

  window.BankUI = { render };
})();
