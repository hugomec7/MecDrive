# MecDrive

As instruções do projeto estão em [AGENTS.md](AGENTS.md) e valem inteiras para o Claude.

@AGENTS.md

## Só para o Claude Code

- A skill `mecdrive` (em `.claude/skills/mecdrive/`) ensina a baixar do Google Drive pelo `mecdrive-cli`. Use quando a pessoa pedir para baixar, listar ou conferir uma pasta do Drive.
- Downloads grandes passam de 2 minutos: rode o `mecdrive-cli download` em segundo plano e acompanhe pelas linhas `progress`.
- Antes de editar `ui/app.js` ou os `.rs`, feche o `MecDrive.exe` que estiver aberto a partir desta pasta, senão a cópia do exe novo falha.
