# Extension navigation hierarchy — Dashboard 0.1.4

## Result

The global navigation entry is now **扩展**. Inside it, each registered plugin/business adapter has its own category. **Obsidian 系列** contains sibling **扩展数据** and **插件信息与接入** views. ThoughtDAG and future adapters receive their own category; plugin information is no longer a global sibling view of all extension data.

Category identifiers and labels come from registered business panels. A business page is assigned using its `data-directory.adapterId`, then matching namespace membership in the same instance/profile. Information-only providers remain discoverable in a category derived from their namespace and registered title. The current Bridge provider has neither a directory reference nor a stored-data namespace, so an explicit compatibility association maps `obsidian-bridge` to the existing `obsidian-series` category. This is the only built-in provider association; the rest of the navigation is metadata-driven.

Visited categories and their information views remain mounted during navigation. Pending/uncertain action receipts and operation IDs survive switches between views and categories. Pages continue to retain their original instance/profile/provider/boot owners. The data view filters to its category before rendering its instance selector and lazy workspace/session/object tree. Redundant adapter tabs are hidden in the category view. Wrapping a client preserves its receiver by explicitly binding the directory and legacy object APIs.

The package version is 0.1.4. No contracts, binding handlers, installation configuration, real homes, or running instances were changed.

## Verification

- Dashboard TypeScript check: passed on final source.
- Dashboard regression suite: 23 files / 77 tests passed; after the final receiver-binding hardening, the 3 affected extension test files / 10 tests passed again.
- Focused cases: dynamically registered category labels; directory-reference precedence; matching namespace within instance/profile; offline/information-only providers; Obsidian Bridge compatibility; category-scoped information forms; retained uncertain operation ID across category switches; legacy client receiver; lazy data reads and stale instance-request cancellation.
- Production build: passed, Vite 7.1.3, 2080 modules, 18 output files.
- `git diff --check`: passed.
- Real-browser layout, including 1000px viewport, focus rendering and real plugin interaction: **未验收** in this source/build task. Deployment and browser acceptance remain with the coordinating task. Synthetic DOM tests do not replace visual acceptance.

## Build handoff

Output directory: `D:\AI\DeepSeekHarness-Plugin\worktrees\session-context-graph-20260913\dsh-session-maintenance\apps\dashboard\dist`.

| File | SHA-256 |
| --- | --- |
| `index.html` | `efdecd0824ea0a27032b6d1f7e5b6088218026306e360d583b1b6aeef7027286` |
| `assets/index-kgC57J-T.js` | `6cd43a33ce5b991b66470d8821308f87a5f800ff779bc21ee2791a022acd0921` |
| `assets/extension-page-DA1fb0IV.js` | `b276ded6ee7071a2af424cce4938869558d4ebc7b81bc2af8def152d61576807` |
| `assets/extension-page-Bw3oOilp.css` | `b1e5d48eb577c4dc49fe606875f958f9e07fe972b775cb0832333dcb52fcf5e5` |

The generated directory is a source-worktree build only. This task did not copy it into any Engine or plugin runtime directory.
