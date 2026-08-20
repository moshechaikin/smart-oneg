## SmartOneg v1.0.2

### Reliability
- **Failover now covers a stuck bridge.** If the primary is running but can no longer reach its hub, the standby takes over, instead of waiting for the primary to go fully offline.
- **Multiple-backup warning.** If more than one backup instance is checking in, the primary shows a red banner so you can fix a duplicate before it causes trouble.

### Setup wizard
- **Home Assistant and Homebridge** are now first-class options in the wizard, with brand icons and a cleaner provider order. Manual entry was removed.
- **Redesigned notifications step.** ntfy and email (Gmail) are now separate, clearly gated cards, and you can point ntfy at your own self-hosted server (it defaults to ntfy.sh).

### Devices and schedules
- **Fixed a dimmer bug** where turning on an off light by dragging the slider to 100% did nothing. It now turns on reliably. This affected real hardware, not just the demo.
- **Save with Cmd/Ctrl+S** in the edit-device dialog.
- **"New only" import filter** hides devices you have already added when importing from a hub.
- **Rule editor improvements:** a reset button to start an action over, clearer wording (open, close, lock), Flash reminders limited to lights and smart plugs with a safety note for plugs, and erev labels on the mini-calendar.

### Fixes
- The dashboard no longer goes blank for a few seconds after you save or discard schedule changes.
- Pasted credentials with stray hidden characters are now rejected with a clear message instead of failing silently.
- Printable zmanim sheets no longer clip their footer when printing.

### Site and docs
- "Caseta" is now correctly written "Caséta" throughout.
- The mobile documentation menu shows a scroll hint, auto-scrolls to your current section, and fits better on small screens.
