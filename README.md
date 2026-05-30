# thefactory-templates-financialplanner

The first Overseer project template — a working investment-planning web app. Fork it from the Overseer "Start from template" wizard and you get a project with:

- A live calculator (compound interest with monthly contributions, Chart.js projection)
- A holdings tracker seeded with three sample Vanguard ETFs
- A "Top picks" panel that the first story personalizes to your chosen investment focus

The repo also ships a [`.factory/`](.factory/) tree (project config + stories), so the moment you open the project in Overseer there's a runnable story sitting in `pending` ready for a CLI/LLM to execute.

## Preview locally

The app is plain HTML/CSS/JS — no build, no deps. Browsers block `fetch()` from `file://`, so serve it over HTTP:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Plan + architecture

The implementation plan for this template **and** the cross-repo work needed to wire it into Overseer end-to-end lives at [docs/implementation-plan.md](docs/implementation-plan.md).
