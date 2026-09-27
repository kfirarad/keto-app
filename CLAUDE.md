# Keto log — project guidelines

This is a small self-project with a single user.

- Work directly on the `master` branch. No feature branches, no pull requests.
- Commit to `master` when a change is done and `python3 check.py` passes, then push to `origin master`.
- After every change, reload the live app: `systemctl --user restart keto.service`, then confirm it is `active` and `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/` returns 200.
- `SPEC.md` is the original v1 spec: do not rewrite it. `README.md` describes current behavior; keep it up to date.
- Never touch `data/keto.sqlite` in tests; `check.py` uses a temp database via `KETO_DB`.
