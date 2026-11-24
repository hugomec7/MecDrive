---
name: mecdrive
description: Baixa, lista ou confere pastas e arquivos do Google Drive pelo mecdrive-cli, mantendo nomes e subpastas e sem nunca sobrescrever nada. Use quando a pessoa colar um link do Drive e pedir para baixar, ver o que tem dentro, saber o tamanho ou conferir se já baixou tudo.
---

# MecDrive pelo terminal

O `mecdrive-cli.exe` fica na raiz do projeto (ou na pasta onde o MecDrive foi instalado: `%LOCALAPPDATA%\MecDrive`). Ele usa o mesmo login do app.

## Passos

1. Confira o login: `mecdrive-cli status --json`. Se `logged_in` for `false`, peça para a pessoa rodar `mecdrive-cli login` (abre o navegador dela). Não tente fazer o login.
2. Veja o que há no link: `mecdrive-cli list "<link>" --json`. Devolve `name`, `kind`, `total_bytes` e `files` com `path` e `size`.
3. Combine o destino com a pessoa se ela não disse. Precisa ser um caminho completo.
4. Simule: `mecdrive-cli download "<link>" --dest "<pasta>" --dry-run --json`. O evento `plan` mostra o que será baixado, o que já existe e os conflitos de tamanho. Se houver conflitos, avise antes de seguir: esses arquivos não serão tocados.
5. Baixe: o mesmo comando sem `--dry-run`. Se for grande, rode em segundo plano e leia as linhas `progress` (`bytes`, `total_bytes`, `speed`, `eta_seconds`).
6. No fim, leia o evento `done` e conte à pessoa: quantos baixados, quantos já existiam, conflitos e erros, e a pasta de destino.

## Opções

| Opção | Efeito |
| --- | --- |
| `--only <texto>` | só arquivos cujo caminho contém o texto; pode repetir |
| `--keep-root` | cria a pasta raiz do link dentro do destino |
| `--subfolder <nome>` | cria essa subpasta dentro do destino |
| `--prefix`, `--suffix` | muda o nome dos arquivos; o sufixo entra antes da extensão |
| `--transfers <n>` | downloads ao mesmo tempo, de 1 a 8 (padrão 4) |

Vários links podem ir no mesmo comando.

## Regras

- Nunca apague nem substitua arquivos no destino para "resolver" um conflito. Quem decide é a pessoa.
- Código de saída `0` é sucesso, `2` é erro ou conflito, `1` é uso errado ou falta de login.
- Caracteres que o Windows não aceita são trocados no nome final (`11/22/26` vira `11-22-26`), então o caminho no disco pode diferir do nome no Drive. Use o `dst` dos eventos, não o `src`.
- Se o Google responder com cota de download excedida, não há o que fazer além de esperar; diga isso em vez de tentar em laço.
