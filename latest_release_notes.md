## SmartOneg v1.1.0

### Webhooks (new)
- **Call your own URLs from rules and scenes.** A new **Webhook** device type lets SmartOneg drive anything it doesn't support natively: a system with only a REST API, a script on another machine, a notification service, or a building system that already has its own Shabbos mode. SmartOneg supplies the Hebrew-calendar timing; the other system does the work.
- **Named calls, not on/off.** A webhook device holds one or more named calls (e.g. *Start heater*, *Stop heater*), and a rule or scene picks one by name, the same way a thermostat rule picks a mode. Scenes can send one call on start and a different one on end.
- **Test before you save.** Every call has a Test button that sends it right now and shows the real status code and response time, so a wrong URL is caught at your desk instead of mid-Yom Tov.
- **Called once, never replayed.** A webhook is sent at most once, at its scheduled time. It is never retried, never re-sent after a restart, reconnect, takeover or settings save, never touched by Child Lock, and deliberately skipped by scene previews.
- Bearer token, username/password, or custom-header authentication per device, plus a per-device timeout so a slow endpoint can never hold up the rest of your schedule.

### Fixes
- **Schedule edits now apply when a rule has already run.** If you changed a rule or scene on erev after its action had fired, the change was saved but never reached the lights. It now applies as soon as you save, following your Child Lock **begins** setting rather than waiting for candle lighting. Saving an ordinary setting still actuates nothing.
- **Flashes are far more visible on Lutron dimmers.** A Lutron dimmer ramps rather than snaps, so flashing an already-on light only dipped it part way before it climbed back. The dark half of the blink is now held long enough to actually reach off. Lights that start off, non-dimmable switches, and other bridges are unchanged.
- **The holiday page shows the whole festival.** Mid-Sukkos or mid-Pesach it only showed the part still ahead. It now shows the full span including the days already past, labels **Chol Hamoed** on the mini calendar, and reads "Now" instead of "Next" once it has begun.

### Away mode
- **A window with no end date.** Choose **Until I turn it off** and presence simulation runs on every Shabbos and Yom Tov from that day on, never expiring on its own. Meant for a vacation home you visit a few times a year.

### Dashboard
- **Clearer schedule messages.** Raw internal names are gone: "2026-09-26: sukkos-1 needs its "on-shabbos" schedule" now reads "Sat, Sep 26: Sukkos I (falls on Shabbos)".
- **Warnings are only for real problems.** A day that falls back to your regular rules is fine, not a warning, so it moved to its own neutral "Good to know" card. Rule conflicts and days with no schedule at all stay as warnings.

### Under the hood
- Updated `@hebcal/core` to 6.9.3.
