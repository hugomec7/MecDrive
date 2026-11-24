// mecdrive-cli: o mesmo motor do MecDrive pelo terminal, pensado para scripts e agentes (Claude Code etc.).
// Regras iguais às do app: nunca sobrescreve nem apaga nada no destino, só usa `rclone copyto`.
#[path = "../shared.rs"]
mod shared;

use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HELP: &str = "mecdrive-cli — baixa pastas e arquivos do Google Drive como estão

USO
  mecdrive-cli status [--json]
  mecdrive-cli login
  mecdrive-cli list <link>... [--json]
  mecdrive-cli download <link>... --dest <pasta> [opções] [--json]

OPÇÕES DE download
  --dest <pasta>       pasta de destino (caminho completo). Obrigatória.
  --subfolder <nome>   cria essa subpasta dentro do destino
  --prefix <texto>     prefixo no nome de cada arquivo
  --suffix <texto>     sufixo no nome de cada arquivo (entra antes da extensão)
  --keep-root          mantém a pasta raiz do link dentro do destino
  --only <texto>       baixa só os arquivos cujo caminho contém esse texto (pode repetir)
  --transfers <n>      downloads ao mesmo tempo (padrão 4)
  --dry-run            mostra o que seria feito, sem baixar
  --json               uma linha JSON por evento (plan, progress, file, done)

SAÍDA
  código 0: tudo certo. 2: algum arquivo com erro ou com tamanho diferente no destino. 1: uso errado ou sem login.
  Arquivo que já existe com o mesmo tamanho é pulado. Com tamanho diferente é avisado e nunca é tocado.";

struct Ctx {
    root: PathBuf,
    conf: PathBuf,
    job: shared::JobHandle,
    json: bool,
}

impl Ctx {
    fn rclone(&self) -> Command {
        let mut c = Command::new(shared::rclone_exe(&self.root));
        c.arg("--config").arg(&self.conf);
        c
    }
}

#[derive(Clone)]
struct Link {
    id: String,
    rk: String,
    name: String,
    folder: bool,
}

#[derive(Clone)]
struct Item {
    link: usize,
    src: String,
    dst: String,
    size: i64,
}

fn parse_link(s: &str) -> Option<(String, String)> {
    let ok = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let take = |rest: &str| rest.chars().take_while(|c| ok(*c)).collect::<String>();
    let rk = s.split("resourcekey=").nth(1).map(take).unwrap_or_default();
    for key in ["/folders/", "/d/", "?id=", "&id="] {
        if let Some(i) = s.find(key) {
            let id = take(&s[i + key.len()..]);
            if id.len() >= 10 {
                return Some((id, rk));
            }
        }
    }
    (s.len() >= 15 && s.chars().all(ok)).then(|| (s.to_string(), rk))
}

fn drive_meta(ctx: &Ctx, id: &str, rk: &str) -> Result<Value, String> {
    let q = format!("files/{id}?fields=id,name,mimeType,size&supportsAllDrives=true");
    let key = format!("{id}/{rk}");
    let rkey = (!rk.is_empty()).then_some(key.as_str());
    let mut last = String::new();
    for n in 0..4 {
        match shared::drive_get(&ctx.conf, &q, rkey) {
            Ok(v) => return Ok(v),
            Err(e) if e.starts_with("HTTP 401") && n == 0 => {
                // token vencido: qualquer chamada do rclone renova e grava o novo
                let _ = ctx.rclone().args(["about", "gdrive:"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
                last = e;
            }
            Err(e) if e.starts_with("HTTP 403") || e.starts_with("HTTP 429") || e.starts_with("HTTP 5") => {
                std::thread::sleep(Duration::from_millis(900 << n));
                last = e;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

fn src_fs(l: &Link) -> String {
    let rk = if l.rk.is_empty() { String::new() } else { format!(",resource_key={}", l.rk) };
    format!("gdrive,root_folder_id={}{}:", l.id, rk)
}

/// Lê um link: devolve o item e a lista (caminho, tamanho) dos arquivos.
fn read_link(ctx: &Ctx, url: &str) -> Result<(Link, Vec<(String, i64)>), String> {
    let (id, rk) = parse_link(url).ok_or_else(|| format!("não reconheci o link: {url}"))?;
    let meta = drive_meta(ctx, &id, &rk).map_err(|e| {
        if e.contains("404") { "o Drive não encontrou esse item para a conta conectada (o link é público ou foi compartilhado com você?)".to_string() } else { e }
    })?;
    let name = meta.get("name").and_then(Value::as_str).unwrap_or("sem nome").to_string();
    let folder = meta.get("mimeType").and_then(Value::as_str) == Some("application/vnd.google-apps.folder");
    let link = Link { id, rk, name: name.clone(), folder };
    if !folder {
        let size = meta.get("size").and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or(-1);
        return Ok((link, vec![(name, size)]));
    }
    let out = ctx
        .rclone()
        .args(["lsjson", "-R", "--files-only", "--no-modtime", "--no-mimetype"])
        .arg(src_fs(&link))
        .output()
        .map_err(|e| format!("não consegui rodar o rclone: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("o rclone falhou ao listar").to_string());
    }
    let list: Vec<Value> = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let mut files: Vec<(String, i64)> = list
        .iter()
        .filter_map(|i| Some((i.get("Path")?.as_str()?.to_string(), i.get("Size").and_then(Value::as_i64).unwrap_or(-1))))
        .collect();
    files.sort();
    Ok((link, files))
}

fn human(n: i64) -> String {
    if n < 0 {
        return "?".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let (mut v, mut i) = (n as f64, 0);
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{n} B") } else { format!("{v:.2} {}", units[i]) }
}

fn file_size(p: &Path) -> i64 {
    match fs::metadata(p) {
        Ok(m) if m.is_dir() => -2,
        Ok(m) => m.len() as i64,
        Err(_) => -1,
    }
}

struct Args {
    cmd: String,
    links: Vec<String>,
    opts: std::collections::HashMap<String, Vec<String>>,
}

fn parse_args() -> Args {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut a = Args { cmd: raw.first().cloned().unwrap_or_default(), links: vec![], opts: Default::default() };
    let flags = ["--json", "--keep-root", "--dry-run", "--help", "-h"];
    let mut i = 1;
    while i < raw.len() {
        let t = &raw[i];
        if flags.contains(&t.as_str()) {
            a.opts.entry(t.clone()).or_default();
        } else if t.starts_with("--") {
            let v = raw.get(i + 1).cloned().unwrap_or_default();
            a.opts.entry(t.clone()).or_default().push(v);
            i += 1;
        } else {
            a.links.push(t.clone());
        }
        i += 1;
    }
    a
}

fn cmd_status(ctx: &Ctx) -> i32 {
    let logged = shared::has_token(&ctx.conf);
    let email = if logged {
        shared::drive_get(&ctx.conf, "about?fields=user(emailAddress)", None)
            .ok()
            .and_then(|v| v.pointer("/user/emailAddress").and_then(Value::as_str).map(str::to_string))
    } else {
        None
    };
    let v = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "root": ctx.root.to_string_lossy(),
        "data": shared::data_dir(&ctx.root).to_string_lossy(),
        "rclone": shared::rclone_exe(&ctx.root).exists(),
        "logged_in": logged,
        "account": email,
    });
    if ctx.json {
        println!("{v}");
    } else {
        println!("MecDrive {}", env!("CARGO_PKG_VERSION"));
        println!("pasta de dados: {}", v["data"].as_str().unwrap_or(""));
        println!("rclone: {}", if v["rclone"] == true { "ok" } else { "NÃO encontrado em bin\\rclone.exe" });
        println!("conta Google: {}", match (&v["account"], logged) { (Value::String(e), _) => e.clone(), (_, true) => "conectada".into(), _ => "sem login (rode: mecdrive-cli login)".into() });
    }
    if logged { 0 } else { 1 }
}

fn cmd_login(ctx: &Ctx) -> i32 {
    let _ = fs::create_dir_all(shared::data_dir(&ctx.root));
    eprintln!("Abrindo o navegador para você autorizar o acesso somente leitura ao Google Drive…");
    let ok = ctx
        .rclone()
        .args(["config", "create", shared::REMOTE, "drive", "scope=drive.readonly"])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok && shared::has_token(&ctx.conf) {
        println!("login concluído");
        0
    } else {
        eprintln!("login não concluído");
        1
    }
}

fn cmd_list(ctx: &Ctx, a: &Args) -> i32 {
    let mut code = 0;
    for url in &a.links {
        match read_link(ctx, url) {
            Ok((link, files)) => {
                let total: i64 = files.iter().map(|f| f.1.max(0)).sum();
                if ctx.json {
                    println!("{}", json!({ "link": url, "id": link.id, "name": link.name, "kind": if link.folder { "folder" } else { "file" },
                        "total_bytes": total, "files": files.iter().map(|f| json!({ "path": f.0, "size": f.1 })).collect::<Vec<_>>() }));
                } else {
                    println!("{} ({}, {} arquivos, {})", link.name, if link.folder { "pasta" } else { "arquivo" }, files.len(), human(total));
                    for f in &files {
                        println!("  {:>10}  {}", human(f.1), f.0);
                    }
                }
            }
            Err(e) => {
                code = 2;
                if ctx.json { println!("{}", json!({ "link": url, "error": e })) } else { eprintln!("erro em {url}: {e}") }
            }
        }
    }
    code
}

fn rename(name: &str, prefix: &str, suffix: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{prefix}{}{suffix}{}", &name[..dot], &name[dot..]),
        _ => format!("{prefix}{name}{suffix}"),
    }
}

fn cmd_download(ctx: Ctx, a: &Args) -> i32 {
    let one = |k: &str| a.opts.get(k).and_then(|v| v.last()).cloned().unwrap_or_default();
    let dest = one("--dest");
    let p = Path::new(&dest);
    if dest.is_empty() || !p.is_absolute() {
        eprintln!("--dest precisa ser um caminho completo, por exemplo --dest \"D:\\Videos\\RAW\"");
        return 1;
    }
    let sub = shared::clean_rel(&one("--subfolder").replace('\\', "/"));
    let base = if sub.is_empty() { PathBuf::from(&dest) } else { p.join(sub.replace('/', "\\")) };
    let (prefix, suffix) = (shared::clean_segment(&format!("{}x", one("--prefix"))), shared::clean_segment(&format!("x{}", one("--suffix"))));
    let (prefix, suffix) = (prefix[..prefix.len() - 1].to_string(), suffix[1..].to_string());
    let keep_root = a.opts.contains_key("--keep-root");
    let only: Vec<String> = a.opts.get("--only").cloned().unwrap_or_default().iter().map(|s| s.to_lowercase()).collect();
    let transfers: usize = one("--transfers").parse().unwrap_or(4).clamp(1, 8);

    // 1) ler os links e montar o plano
    let mut links = vec![];
    let mut items: Vec<Item> = vec![];
    let mut seen = HashSet::new();
    for url in &a.links {
        let (link, files) = match read_link(&ctx, url) {
            Ok(r) => r,
            Err(e) => {
                if ctx.json { println!("{}", json!({ "event": "error", "link": url, "error": e })) } else { eprintln!("erro em {url}: {e}") }
                return 2;
            }
        };
        let li = links.len();
        for (src, size) in files {
            if !only.is_empty() && !only.iter().any(|o| src.to_lowercase().contains(o)) {
                continue;
            }
            let (dir, leaf) = match src.rfind('/') { Some(i) => (&src[..=i], &src[i + 1..]), None => ("", src.as_str()) };
            // o nome da pasta raiz pode ter "/" (ex.: 11/22/26): ele é limpo inteiro, como um nome só
            let root = if link.folder && keep_root { format!("{}/", shared::clean_segment(&link.name)) } else { String::new() };
            let mut dst = format!("{root}{}", shared::clean_rel(&format!("{dir}{}", rename(leaf, &prefix, &suffix))));
            let mut n = 1;
            while !seen.insert(dst.to_lowercase()) {
                n += 1;
                dst = format!("{root}{}", shared::clean_rel(&format!("{dir}{}", rename(leaf, &prefix, &format!("{suffix} ({n})")))));
            }
            items.push(Item { link: li, src, dst, size });
        }
        links.push(link);
    }

    // 2) o que já existe no destino: mesmo tamanho é pulado, tamanho diferente nunca é tocado
    let local = |it: &Item| base.join(it.dst.replace('/', "\\"));
    let (mut queue, mut skipped, mut conflicts) = (VecDeque::new(), vec![], vec![]);
    for (k, it) in items.iter().enumerate() {
        match file_size(&local(it)) {
            -1 => queue.push_back(k),
            s if s == it.size || it.size < 0 => skipped.push(it.dst.clone()),
            s => conflicts.push(json!({ "path": local(it).to_string_lossy(), "on_disk": s, "on_drive": it.size })),
        }
    }
    let total: i64 = queue.iter().map(|k| items[*k].size.max(0)).sum();
    if ctx.json {
        println!("{}", json!({ "event": "plan", "dest": base.to_string_lossy(), "to_download": queue.len(), "bytes": total, "skipped_existing": skipped.len(), "conflicts": conflicts,
            "files": queue.iter().map(|k| json!({ "src": items[*k].src, "dst": items[*k].dst, "size": items[*k].size })).collect::<Vec<_>>() }));
    } else {
        println!("destino: {}", base.display());
        println!("{} para baixar ({}), {} já existem e serão pulados, {} com tamanho diferente (não serão tocados)", queue.len(), human(total), skipped.len(), conflicts.len());
        for c in &conflicts {
            println!("  TAMANHO DIFERENTE: {} (disco {}, Drive {})", c["path"].as_str().unwrap_or(""), human(c["on_disk"].as_i64().unwrap_or(0)), human(c["on_drive"].as_i64().unwrap_or(0)));
        }
    }
    if a.opts.contains_key("--dry-run") {
        if !ctx.json {
            for k in &queue {
                println!("  {:>10}  {}", human(items[*k].size), items[*k].dst);
            }
        }
        return if conflicts.is_empty() { 0 } else { 2 };
    }

    // 3) baixar: N processos `rclone copyto`, um por arquivo
    let ctx = Arc::new(ctx);
    let items = Arc::new(items);
    let links = Arc::new(links);
    let queue = Arc::new(Mutex::new(queue));
    let live: Arc<Mutex<std::collections::HashMap<usize, (i64, f64)>>> = Arc::new(Mutex::new(Default::default()));
    let results: Arc<Mutex<Vec<(usize, Result<(), String>)>>> = Arc::new(Mutex::new(vec![]));
    let base = Arc::new(base);
    let started = Instant::now();
    let mut workers = vec![];
    for _ in 0..transfers {
        let (ctx, items, links, queue, live, results, base) = (ctx.clone(), items.clone(), links.clone(), queue.clone(), live.clone(), results.clone(), base.clone());
        workers.push(std::thread::spawn(move || loop {
            let Some(k) = queue.lock().unwrap().pop_front() else { break };
            let it = &items[k];
            let link = &links[it.link];
            let target = base.join(it.dst.replace('/', "\\"));
            let mut res = Err("não tentou".to_string());
            for attempt in 0..4 {
                if file_size(&target) != -1 {
                    res = Err("apareceu um arquivo no destino durante o download; não foi tocado".to_string());
                    break;
                }
                if attempt > 0 {
                    std::thread::sleep(Duration::from_secs(5 << attempt));
                }
                let mut c = ctx.rclone();
                if link.folder {
                    c.arg("copyto").arg(format!("{}{}", src_fs(link), it.src)).arg(&target);
                } else {
                    let rk = if link.rk.is_empty() { String::new() } else { format!(",resource_key={}", link.rk) };
                    c.args(["backend", "copyid"]).arg(format!("gdrive{rk}:")).arg(&link.id).arg(&target);
                }
                c.args(["--ignore-existing", "--drive-acknowledge-abuse", "--drive-chunk-size", "64M", "--retries", "3", "--low-level-retries", "10"])
                    .args(["--stats", "1s", "--use-json-log", "--log-level", "INFO"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped());
                let mut child = match c.spawn() {
                    Ok(ch) => ch,
                    Err(e) => { res = Err(format!("não consegui rodar o rclone: {e}")); break }
                };
                ctx.job.assign(&child);
                let mut last_err = String::new();
                if let Some(err) = child.stderr.take() {
                    for line in BufReader::new(err).lines().map_while(Result::ok) {
                        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                        if let Some(s) = v.get("stats") {
                            live.lock().unwrap().insert(k, (s.get("bytes").and_then(Value::as_i64).unwrap_or(0), s.get("speed").and_then(Value::as_f64).unwrap_or(0.0)));
                        } else if v.get("level").and_then(Value::as_str) == Some("error") {
                            last_err = v.get("msg").and_then(Value::as_str).unwrap_or("").to_string();
                        }
                    }
                }
                let ok = child.wait().map(|s| s.success()).unwrap_or(false);
                live.lock().unwrap().remove(&k);
                let got = file_size(&target);
                if ok && got >= 0 && (got == it.size || it.size < 0) {
                    res = Ok(());
                    break;
                }
                res = Err(if !last_err.is_empty() { last_err } else if got >= 0 { "tamanho final diferente do Drive".to_string() } else { "o rclone terminou sem gravar o arquivo".to_string() });
            }
            if ctx.json {
                println!("{}", json!({ "event": "file", "dst": it.dst, "size": it.size, "ok": res.is_ok(), "error": res.clone().err() }));
            } else {
                match &res { Ok(()) => println!("ok    {}", it.dst), Err(e) => println!("ERRO  {}: {e}", it.dst) }
            }
            results.lock().unwrap().push((k, res));
        }));
    }
    let mut last_print = Instant::now();
    while workers.iter().any(|w| !w.is_finished()) {
        std::thread::sleep(Duration::from_millis(500));
        if last_print.elapsed() < Duration::from_secs(if ctx.json { 2 } else { 5 }) {
            continue;
        }
        last_print = Instant::now();
        let done: i64 = results.lock().unwrap().iter().filter(|r| r.1.is_ok()).map(|r| items[r.0].size.max(0)).sum();
        let (cur, speed) = live.lock().unwrap().values().fold((0i64, 0f64), |a, v| (a.0 + v.0, a.1 + v.1));
        let got = done + cur;
        let eta = if speed > 0.0 { ((total - got).max(0) as f64 / speed) as i64 } else { -1 };
        if ctx.json {
            println!("{}", json!({ "event": "progress", "bytes": got, "total_bytes": total, "speed": speed as i64, "eta_seconds": eta, "files_done": results.lock().unwrap().len(), "files_total": items.len() - skipped.len() - conflicts.len() }));
        } else {
            println!("{:>3}%  {} de {}  {}/s  faltam {}", if total > 0 { got * 100 / total } else { 0 }, human(got), human(total), human(speed as i64), if eta >= 0 { format!("{} min {:02} s", eta / 60, eta % 60) } else { "?".into() });
        }
    }
    for w in workers {
        let _ = w.join();
    }
    let results = results.lock().unwrap();
    let errors: Vec<Value> = results.iter().filter_map(|r| r.1.clone().err().map(|e| json!({ "dst": items[r.0].dst, "error": e }))).collect();
    let ok_n = results.iter().filter(|r| r.1.is_ok()).count();
    if ctx.json {
        println!("{}", json!({ "event": "done", "dest": base.to_string_lossy(), "downloaded": ok_n, "skipped_existing": skipped.len(), "conflicts": conflicts, "errors": errors, "seconds": started.elapsed().as_secs() }));
    } else {
        println!("concluído em {} s: {} baixados, {} já existiam, {} com tamanho diferente, {} com erro", started.elapsed().as_secs(), ok_n, skipped.len(), conflicts.len(), errors.len());
    }
    if errors.is_empty() && conflicts.is_empty() { 0 } else { 2 }
}

fn main() {
    let a = parse_args();
    let root = shared::find_root();
    let conf = shared::data_dir(&root).join("rclone.conf");
    let ctx = Ctx { root, conf, job: shared::JobHandle::new(), json: a.opts.contains_key("--json") };
    if a.cmd.is_empty() || a.cmd == "help" || a.opts.contains_key("--help") || a.opts.contains_key("-h") {
        println!("{HELP}");
        return;
    }
    if !shared::rclone_exe(&ctx.root).exists() {
        eprintln!("rclone.exe não encontrado em {}", shared::rclone_exe(&ctx.root).display());
        std::process::exit(1);
    }
    let needs_login = matches!(a.cmd.as_str(), "list" | "download");
    if needs_login && !shared::has_token(&ctx.conf) {
        eprintln!("sem login no Google. Rode: mecdrive-cli login");
        std::process::exit(1);
    }
    if needs_login && a.links.is_empty() {
        eprintln!("faltou o link. Veja: mecdrive-cli help");
        std::process::exit(1);
    }
    let code = match a.cmd.as_str() {
        "status" => cmd_status(&ctx),
        "login" => cmd_login(&ctx),
        "list" => cmd_list(&ctx, &a),
        "download" => cmd_download(ctx, &a),
        other => {
            eprintln!("comando desconhecido: {other}\n\n{HELP}");
            1
        }
    };
    std::process::exit(code);
}
