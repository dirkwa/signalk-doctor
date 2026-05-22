// Tiny redirect shell: ask the plugin for the externalUrl, then redirect.
// If the plugin is unreachable (signalk-server missing) or the updater
// container is down, render a friendly explanation instead of a blank page.

interface GuiUrlResponse {
  url: string;
}

const msg = document.getElementById('msg');
const actions = document.getElementById('actions');

async function bootstrap(): Promise<void> {
  try {
    const res = await fetch('/plugins/signalk-doctor/api/gui-url');
    if (!res.ok) throw new Error(`plugin API returned HTTP ${res.status}`);
    const body = (await res.json()) as GuiUrlResponse;
    if (!body.url) throw new Error('no url in plugin response');

    // Probe the updater itself before redirecting, so we can show a useful
    // error if the container is down (instead of a generic "page can't load").
    try {
      const health = await fetch(`${body.url.replace(/\/$/, '')}/api/health`, {
        method: 'GET',
        mode: 'no-cors',
      });
      // no-cors gives us opaque responses; reaching here at all means TCP reach.
      void health;
    } catch (probeErr) {
      if (msg) {
        msg.innerHTML = `<span class="err">Doctor container is not reachable at <code>${body.url}</code>.</span>
        <p>The doctor is your offline recovery surface, so this being down is unusual.
        Open an SSH session and run:</p>
        <pre>systemctl --user status signalk-doctor-server.service
~/.local/bin/signalk-recovery doctor   # status snapshot
~/.local/bin/signalk-recovery rollback-all   # restore last-known-good</pre>
        <p>Original error: <code>${probeErr instanceof Error ? probeErr.message : String(probeErr)}</code></p>`;
      }
      return;
    }

    if (msg) {
      msg.innerHTML = `<span class="ok">Doctor Console is reachable.</span>
      Redirecting to <code>${body.url}</code>…`;
    }
    window.location.replace(body.url);
  } catch (err) {
    if (msg) {
      msg.innerHTML = `<span class="err">Could not contact the signalk-doctor plugin.</span>
      <p>Either the plugin is disabled or signalk-server is unhealthy.
      The Doctor Console may still be reachable directly:</p>`;
    }
    if (actions) {
      actions.style.display = 'block';
      actions.innerHTML = '<a href="http://localhost:3004">Open Doctor Console on :3004</a>';
    }
    console.error(err);
  }
}

void bootstrap();
