# MecDrive: guia para agentes

MecDrive é um app de Windows (Tauri v2 + Rust) que baixa pastas e arquivos do Google Drive como estão, usando o rclone como motor. Há também uma linha de comando, `mecdrive-cli.exe`, com as mesmas regras.

## Regras que não podem ser quebradas

- Nunca sobrescrever nem apagar nada no destino. Só `rclone copyto` / `operations/copyfile` com `--ignore-existing`; nunca `sync` ou `move`. A única remoção permitida são os temporários `<arquivo>.<8 caracteres>.partial` do próprio rclone (`clean_partials` em `main.rs`).
- Arquivo que já existe com o mesmo tamanho é pulado. Com tamanho diferente é um conflito: avisa e não toca.
- Nada de dados pessoais ou segredos no repositório. `data/` (token do Google em `rclone.conf`, histórico, configuração) e `bin/` ficam fora do git. Não registre o token em log nem o imprima.
- O acesso ao Drive é somente leitura (`scope=drive.readonly`). Não peça escopo maior.
- A limpeza de nomes para o Windows existe em dois lugares e precisa ser igual: `cleanSeg` em `ui/app.js` e `clean_segment` em `src-tauri/src/shared.rs`.

## Onde está cada coisa

| Caminho | O que é |
| --- | --- |
| `src-tauri/src/main.rs` | Comandos Tauri: sobe `rclone rcd` em 127.0.0.1 com senha sorteada, repassa chamadas rc, disco, login, atualização |
| `src-tauri/src/bin/mecdrive-cli.rs` | Linha de comando (um `rclone copyto` por arquivo) |
| `src-tauri/src/shared.rs` | Comum aos dois: pasta de dados, consulta à API do Drive, limpeza de nomes, Job Object |
| `ui/index.html`, `ui/app.js` | Interface e fila de downloads. A lógica de download do app mora no `app.js` |
| `tools/` | `get-rclone.ps1`, `make-portable.ps1` e os scripts de teste `cdp.js` / `rc.js` |
| `docs/` | Logo, hero do README e a fonte dela (`hero.html`) |

Pasta de dados: `data\` ao lado do exe se ela existir (portátil e desenvolvimento), senão `%APPDATA%\MecDrive` (instalado).

## Montar

```
powershell -ExecutionPolicy Bypass -File tools\get-rclone.ps1   # uma vez: baixa bin\rclone.exe e confere o SHA256
cd src-tauri
cargo build --release                                           # MecDrive.exe e mecdrive-cli.exe
npx @tauri-apps/cli@2 build                                     # instalador NSIS
cd ..
powershell -ExecutionPolicy Bypass -File tools\make-portable.ps1
```

`tauri.conf.json` lista `bin/rclone.exe` e `target/release/mecdrive-cli.exe` como recursos, então os dois precisam existir antes do `cargo build` (num clone novo, rode `cargo build --release --bin mecdrive-cli` primeiro). Para testar na raiz do projeto, copie `target\release\MecDrive.exe` e `mecdrive-cli.exe` para a raiz; feche o app antes, o exe fica travado enquanto roda.

Não há testes automatizados. Verifique `node --check ui/app.js` e um build limpo sem avisos.

## Testar o app sem mexer na área de trabalho

Abra o app com a porta de depuração do WebView2 e dirija a janela por script:

```
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'; Start-Process .\MecDrive.exe
node tools/cdp.js 9333 eval "DD.S.phase"
node tools/cdp.js 9333 evalfile caminho\script.js
node tools/cdp.js 9333 shot print.png
```

`window.DD` expõe o estado (`DD.S`) e as funções principais (`addLinks`, `startDownload`, `togglePause`, `cancelDownload`, `setView`, `setZoom`). Baixe sempre para uma pasta temporária, nunca para a pasta de trabalho real de alguém.

## Usar o MecDrive para baixar algo

Prefira a linha de comando com `--json`:

```
mecdrive-cli status --json
mecdrive-cli list "<link>" --json
mecdrive-cli download "<link>" --dest "<pasta completa>" --dry-run --json
mecdrive-cli download "<link>" --dest "<pasta completa>" --json
```

- Rode `--dry-run` antes e mostre o plano à pessoa quando o download for grande ou o destino já tiver arquivos.
- Códigos de saída: `0` tudo certo, `2` algum erro ou conflito de tamanho, `1` uso errado ou sem login.
- Sem login, peça para a pessoa rodar `mecdrive-cli login` (abre o navegador dela). Nunca faça o login por ela.
- `--only <texto>` filtra por parte do caminho e pode repetir. `--keep-root`, `--subfolder`, `--prefix`, `--suffix` e `--transfers` funcionam como no app.

## Convenções

- Textos da interface e comentários em português do Brasil.
- Interface: grafite neutro, um só acento, espaçamentos na grade de 4 px, sem brilhos nem degradês. Botões de janela no padrão do Windows. As ações do app ficam no menu que abre ao clicar no nome.
- Versão em `src-tauri/Cargo.toml` e `src-tauri/tauri.conf.json`. Uma release no GitHub com a tag `vX.Y.Z` é o que o aviso de atualização do app consulta.
