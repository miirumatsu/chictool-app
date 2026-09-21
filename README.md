# CHICTool

Electron front end for the CHICTool hardware inventory workflow. The application stores inventory in SQLite and uses a constrained PowerShell worker for local and remote hardware collection.

## Run

```powershell
npm install
npm start
```

The first launch creates `data/pcinfo.db` for compatibility with existing installations. Existing PowerShell scripts and CSV files are preserved.

## Current MVP

- Browse inventory records from SQLite.
- Collect local hardware with PowerShell.
- Collect remote hardware through WinRM using a credential supplied at runtime.
- Review and save constrained metadata fields.
- Keep PowerShell execution behind the Electron main process and preload IPC bridge.

Remote collection requires WinRM connectivity and appropriate permissions on the target computer. Credentials are passed to the worker through standard input and are not stored in SQLite or the `data` directory.
