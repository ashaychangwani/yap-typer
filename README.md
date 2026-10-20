# Yap Typer

A small local app for a shared Todo list and timed, write-only brain dump sessions. It uses no external packages or accounts.

![Yap Typer preview](assets/preview.png)

## Run it

Install [Node.js 20 or newer](https://nodejs.org/) if needed. In this folder, run:

```sh
npm start
```

Open <http://127.0.0.1:4173> in your browser. Keep the terminal open while using the app. You can also set `PORT` to choose another port.

## How it works

1. The app opens on your shared Todo list. Add tasks directly, check them off, or open one to edit its title and full notes. Notes stay short in the list view. Todos are grouped by their last update date, with the most recently updated first.
2. Start a session and choose the two timer lengths (default: 2 minutes and 1 minute).
3. The brain dump timer starts with your first character. Deleting, replacing, cutting, and undoing are blocked. The task list stays locked until the dump timer ends.
4. The task list timer starts when you begin writing. Put one task on each line. You can edit the list during its timer, or finish it early.
5. When the list timer ends, the checklist opens. Its tasks also appear in the shared Todo list and remain there across sessions.

Sessions are saved in the `data/` folder as one readable JSON file per session. The shared list is saved in `data/todos.json`. Existing session tasks are copied into it the first time the updated app starts. The brain dump is in `dumpText`, and checklist items are in `tasks`. You can also download a session from the app. Set `YAP_TYPER_DATA_DIR` to save all data files elsewhere.

When run directly, the server listens only on `127.0.0.1`. The Docker image listens inside its container on all interfaces; the command below publishes its port only to your computer.

## Docker

GitHub Actions builds and publishes the image for Intel and ARM64 machines whenever `main` changes. To run the published image while keeping your Todo list and session files in this folder:

```sh
mkdir -p data
docker run --rm --name yap-typer \
  --publish 127.0.0.1:4173:4173 \
  --mount "type=bind,source=$(pwd)/data,target=/data" \
  --user "$(id -u):$(id -g)" \
  ghcr.io/ashaychangwani/yap-typer:latest
```

Then open <http://127.0.0.1:4173>. The bind mount keeps your JSON sessions in `data/` after the container stops. To build locally instead, run `docker build -t yap-typer .` and replace the image name in the command above with `yap-typer`.

## License

MIT. See [LICENSE](LICENSE).
