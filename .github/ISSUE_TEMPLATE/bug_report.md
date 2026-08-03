---
name: Bug report
about: Something isn't working the way it should
title: ''
labels: bug
assignees: ''

---

**What happened**
A clear description of the bug, and what you expected instead.

**Steps to reproduce**
1. Go to '...'
2. Click '...'
3. See '...'

**When did it happen**
Roughly what date/time, and was a Shabbos or Yom Tov (or test mode) active at the time? This helps line the logs up with the event.

**Your setup**
- SmartOneg version: (Settings → About)
- Install method: Docker / Homebrew / pm2 / other
- Integrations in use: Lutron / Home Assistant / Homebridge / Hubitat / Matter / Ecobee / EnvisaLink
- Where you saw it: browser + OS (e.g. Safari on iOS, Chrome on macOS)

**Redacted config**
Settings → System → the **Export current config** button's dropdown → **Export redacted config**. This strips your location, emails, hosts, passwords and tokens, so it's safe to share. Drag the downloaded `smartoneg-config-redacted-*.json` onto this issue, or paste it here:

```json
(paste redacted config here, or attach the file above)
```

**Redacted logs**
Logs page → the **Download** button's dropdown → **Download redacted logs** (IPs, emails and secrets stripped). Drag the downloaded `smartoneg-redacted-*.log` onto this issue, or paste the relevant lines here:

```
(paste redacted logs here, or attach the file above)
```

**Screenshots**
If it's a visual bug, a screenshot goes a long way.

**Anything else**
Other context that might help.
