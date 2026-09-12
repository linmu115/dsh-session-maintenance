# Borrow the live RC2 projection domain

The actual Core binding fixture failed because SessionProjectionCache had already opened its single-owner `session_projcache` domain. The binding now borrows that domain through the public `storageDomain.get()` lookup, after checking the live cache instance belongs to the attested module. It refuses an uninitialized domain before installing any writer guards.

The host cache retains ownership on binding disposal and initialization failure. The binding never opens or closes that domain. Tests use a host-owned domain whose open/close throw, exercise metadata and writer admission, and check missing-domain refusal leaves persistence unchanged. Real CLI binding/handle acceptance remains a separate required fixture.
