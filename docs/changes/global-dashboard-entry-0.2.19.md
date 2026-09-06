# Maintenance 0.2.19: global Dashboard navigation

The RC1 settings action "打开完整看板" supplied the current native session ID.
The proxy correctly treated the request as session-targeted navigation and
resolved it in the active projection run before creating a Dashboard launch
code. An unmapped or previous-run selection therefore blocked the global UI
with `Session is not mapped in this active projection run`.

Settings and the optional sidebar now request a Dashboard launch without a
session ID. Session context-menu navigation retains exact target resolution;
the proxy does not suppress mapping errors or fall back to another session.
No Engine, database, projection mapping or synchronization behavior changes.

The regression invokes the actual rendered settings button with the real
restricted proxy and a synthetic Engine transport. Before the fix it reproduces
the reported error for an unmapped and a previous-run selection. It also covers
no current selection, global navigation, and strict failure for targeted
navigation. The previous live smoke check sent a sessionless request directly,
so it did not cover the settings button's session parameter.

Release: Maintenance plugin 0.2.19, paired with the unchanged Engine 0.1.16 and
SCM 0.3.2 on DSH 0.1.2-rc.1 / web. Focused plugin tests, build, typecheck and
package checks are required before activation; activation evidence is recorded
separately. Test fixtures do not access real user sessions.
