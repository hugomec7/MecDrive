// MecDrive: baixa pastas do Google Drive como estão, usando o rclone como motor.
// O Rust aqui é fino: sobe o `rclone rcd`, repassa chamadas rc e faz as operações de disco.
// A fila de downloads e a interface ficam em ui/app.js.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde_json::{json, Value};
use std::ffi::c_void;
use std::fs;
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

mod shared;
use shared::{JobHandle, NO_WINDOW, REMOTE, REPO};

#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(handle: *mut c_void) -> i32;
    fn NtResumeProcess(handle: *mut c_void) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
}

struct Rcd {
    child: Child,
    port: u16,
    auth: String,
}

struct AppState {
    root: PathBuf,
    rcd: Mutex<Option<Rcd>>,
    login_pid: Mutex<Option<u32>>,
    job: JobHandle,
}

impl AppState {
    fn rclone(&self) -> PathBuf {
        shared::rclone_exe(&self.root)
    }
    fn data(&self) -> PathBuf {
        shared::data_dir(&self.root)
    }
    fn conf(&self) -> PathBuf {
        self.data().join("rclone.conf")
    }
}

fn random_hex() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn kill_pid(pid: u32, only_rclone: bool) {
    let mut c = Command::new("taskkill");
    c.args(["/PID", &pid.to_string(), "/T", "/F"]);
    if only_rclone {
        c.args(["/FI", "IMAGENAME eq rclone.exe"]);
    }
    let _ = c.creation_flags(NO_WINDOW).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

fn stop_rcd(state: &AppState) {
    if let Some(mut r) = state.rcd.lock().unwrap().take() {
        unsafe { NtResumeProcess(r.child.as_raw_handle() as *mut c_void) };
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
    // segunda garantia: um rcd de uma execução anterior, anotado em rcd.pid
    let pid_file = state.data().join("rcd.pid");
    if let Ok(old) = fs::read_to_string(&pid_file) {
        if let Ok(pid) = old.trim().parse::<u32>() {
            kill_pid(pid, true);
        }
    }
    let _ = fs::remove_file(pid_file);
}

fn rc_call(port: u16, auth: &str, method: &str, params: &Value, timeout: Option<Duration>) -> Result<Value, String> {
    let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(4));
    if let Some(t) = timeout {
        b = b.timeout(t);
    }
    let url = format!("http://127.0.0.1:{port}/{method}");
    match b.build().post(&url).set("Authorization", auth).send_json(params.clone()) {
        Ok(resp) => resp.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, resp)) => {
            let body: Value = resp.into_json().unwrap_or(Value::Null);
            Err(body.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("rclone respondeu HTTP {code}")))
        }
        Err(e) => Err(format!("sem resposta do rclone: {e}")),
    }
}

#[tauri::command]
fn app_info(state: State<AppState>) -> Value {
    let downloads = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("Downloads").join("MecDrive");
    json!({
        "root": state.root.to_string_lossy(),
        "data": state.data().to_string_lossy(),
        "hasRclone": state.rclone().exists(),
        "hasToken": shared::has_token(&state.conf()),
        "downloads": downloads.to_string_lossy(),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// (Re)inicia o `rclone rcd` escutando só em 127.0.0.1, com usuário e senha sorteados a cada vez.
#[tauri::command]
async fn rcd_start(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if !state.rclone().exists() {
            return Err("rclone.exe não encontrado na pasta bin do app".to_string());
        }
        stop_rcd(&state);
        let data = state.data();
        fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let log = data.join("rclone.log");
        if fs::metadata(&log).map(|m| m.len() > 8_000_000).unwrap_or(false) {
            let _ = fs::rename(&log, data.join("rclone.old.log"));
        }
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .map_err(|e| e.to_string())?;
        let (user, pass) = ("mecdrive".to_string(), random_hex());
        let child = Command::new(state.rclone())
            .arg("rcd")
            .args(["--rc-addr", &format!("127.0.0.1:{port}")])
            .args(["--rc-user", &user, "--rc-pass", &pass])
            .arg("--config")
            .arg(state.conf())
            .arg("--log-file")
            .arg(&log)
            .args(["--log-level", "INFO", "--use-json-log"])
            .args(["--drive-chunk-size", "64M", "--drive-acknowledge-abuse"])
            .args(["--transfers", "4", "--retries", "3", "--low-level-retries", "10"])
            .args(["--rc-job-expire-duration", "24h"])
            .creation_flags(NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("não consegui iniciar o rclone: {e}"))?;
        state.job.assign(&child);
        let _ = fs::write(data.join("rcd.pid"), child.id().to_string());
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}")));
        *state.rcd.lock().unwrap() = Some(Rcd { child, port, auth: auth.clone() });
        let t0 = Instant::now();
        loop {
            if rc_call(port, &auth, "rc/noop", &json!({}), Some(Duration::from_secs(2))).is_ok() {
                return Ok(());
            }
            if t0.elapsed() > Duration::from_secs(15) {
                return Err("o rclone não respondeu ao iniciar".to_string());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rc(state: State<'_, AppState>, method: String, params: Value, timeout_secs: Option<u64>) -> Result<Value, String> {
    let (port, auth) = match state.rcd.lock().unwrap().as_ref() {
        Some(r) => (r.port, r.auth.clone()),
        None => return Err("rclone parado".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || rc_call(port, &auth, &method, &params, timeout_secs.map(Duration::from_secs)))
        .await
        .map_err(|e| e.to_string())?
}

/// Pausar de verdade: congela o processo do rclone (as transferências ficam paradas no meio do arquivo).
#[tauri::command]
fn rcd_pause(state: State<AppState>, pause: bool) -> Result<(), String> {
    match state.rcd.lock().unwrap().as_ref() {
        Some(r) => {
            let h = r.child.as_raw_handle() as *mut c_void;
            let st = unsafe { if pause { NtSuspendProcess(h) } else { NtResumeProcess(h) } };
            if st < 0 { Err(format!("falha ao pausar (status {st:#x})")) } else { Ok(()) }
        }
        None => Err("rclone parado".to_string()),
    }
}

/// Login do Google pelo fluxo OAuth do próprio rclone: abre o navegador do usuário e grava o token em data/rclone.conf.
#[tauri::command]
async fn google_login(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        fs::create_dir_all(state.data()).map_err(|e| e.to_string())?;
        let child = Command::new(state.rclone())
            .args(["config", "create", REMOTE, "drive", "scope=drive.readonly"])
            .arg("--config")
            .arg(state.conf())
            .creation_flags(NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        *state.login_pid.lock().unwrap() = Some(child.id());
        let out = child.wait_with_output().map_err(|e| e.to_string());
        *state.login_pid.lock().unwrap() = None;
        let out = out?;
        if out.status.success() && shared::has_token(&state.conf()) {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            let tail: Vec<&str> = err.lines().rev().take(3).collect();
            Err(if tail.is_empty() { "login cancelado".to_string() } else { tail.into_iter().rev().collect::<Vec<_>>().join(" ") })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn google_login_cancel(state: State<AppState>) {
    if let Some(pid) = state.login_pid.lock().unwrap().take() {
        kill_pid(pid, true);
    }
}

#[tauri::command]
fn google_logout(state: State<AppState>) -> Result<(), String> {
    stop_rcd(&state);
    let _ = Command::new(state.rclone())
        .args(["config", "delete", REMOTE, "--config"])
        .arg(state.conf())
        .creation_flags(NO_WINDOW)
        .status();
    Ok(())
}

/// Consulta só de leitura à API do Drive (nome do item do link e e-mail da conta), com o token do rclone.
#[tauri::command]
async fn drive_get(state: State<'_, AppState>, query: String, resource_key: Option<String>) -> Result<Value, String> {
    let conf = state.conf();
    tauri::async_runtime::spawn_blocking(move || shared::drive_get(&conf, &query, resource_key.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_dirs(path: String) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(&path)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Tamanho de cada caminho: -1 se não existe, -2 se é pasta.
#[tauri::command]
fn stat_files(paths: Vec<String>) -> Vec<i64> {
    paths
        .iter()
        .map(|p| match fs::metadata(p) {
            Ok(m) if m.is_dir() => -2,
            Ok(m) => m.len() as i64,
            Err(_) => -1,
        })
        .collect()
}

/// Remove só os temporários que o próprio rclone deixou (`<arquivo>.<8 caracteres>.partial`) quando o app
/// fechou no meio de um download. Nunca toca em outro tipo de arquivo.
#[tauri::command]
fn clean_partials(files: Vec<String>) -> u32 {
    let mut n = 0;
    for f in files {
        let p = PathBuf::from(&f);
        let (Some(dir), Some(name)) = (p.parent(), p.file_name().map(|s| s.to_string_lossy().to_string())) else { continue };
        let Ok(rd) = fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let en = e.file_name().to_string_lossy().to_string();
            let Some(mid) = en.strip_prefix(&format!("{name}.")).and_then(|r| r.strip_suffix(".partial")) else { continue };
            let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
            if is_file && mid.len() == 8 && mid.chars().all(|c| c.is_ascii_alphanumeric()) && fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

fn json_path(state: &AppState, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase()) {
        return Err("nome inválido".to_string());
    }
    Ok(state.data().join(format!("{name}.json")))
}

#[tauri::command]
fn read_json(state: State<AppState>, name: String) -> Result<Value, String> {
    let p = json_path(&state, &name)?;
    let mut s = String::new();
    match fs::File::open(p) {
        Ok(mut f) => {
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            Ok(serde_json::from_str(&s).unwrap_or(Value::Null))
        }
        Err(_) => Ok(Value::Null),
    }
}

#[tauri::command]
fn write_json(state: State<AppState>, name: String, value: Value) -> Result<(), String> {
    let p = json_path(&state, &name)?;
    fs::create_dir_all(state.data()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(app: AppHandle, start: Option<String>) -> Option<String> {
    let mut d = app.dialog().file().set_title("Escolher pasta de destino");
    if let Some(s) = start.filter(|s| Path::new(s).is_dir()) {
        d = d.set_directory(s);
    }
    d.blocking_pick_folder().map(|p| p.to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let mut p = PathBuf::from(path.replace('/', "\\"));
    while !p.is_dir() {
        if !p.pop() {
            return Err("pasta não encontrada".to_string());
        }
    }
    Command::new("explorer.exe").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Espaço livre (bytes) no disco do caminho dado, mesmo que a pasta ainda não exista.
#[tauri::command]
fn disk_free(path: String) -> Option<u64> {
    let mut p = PathBuf::from(path.replace('/', "\\"));
    while !p.is_dir() {
        if !p.pop() {
            return None;
        }
    }
    let wide: Vec<u16> = p.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let mut avail = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(avail)
}

/// Abre o Explorer com o arquivo selecionado.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = path.replace('/', "\\");
    if !Path::new(&p).exists() {
        return open_folder(p);
    }
    Command::new("explorer.exe").raw_arg(format!("/select,\"{p}\"")).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn version_parts(v: &str) -> Vec<u32> {
    v.trim_start_matches(['v', 'V']).split(['.', '-']).map(|x| x.parse().unwrap_or(0)).collect()
}

/// Consulta a última release publicada no GitHub e diz se é mais nova que esta versão.
#[tauri::command]
async fn check_update() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = env!("CARGO_PKG_VERSION");
        let r = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .build()
            .get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))
            .set("User-Agent", "MecDrive")
            .set("Accept", "application/vnd.github+json")
            .call();
        match r {
            Ok(resp) => {
                let v: Value = resp.into_json().map_err(|e| e.to_string())?;
                let tag = v.get("tag_name").and_then(Value::as_str).unwrap_or("").to_string();
                let newer = !tag.is_empty() && version_parts(&tag) > version_parts(current);
                Ok(json!({ "current": current, "latest": tag, "newer": newer,
                    "url": v.get("html_url").and_then(Value::as_str).unwrap_or(""),
                    "notes": v.get("body").and_then(Value::as_str).unwrap_or("") }))
            }
            Err(ureq::Error::Status(404, _)) => Ok(json!({ "current": current, "latest": "", "newer": false })),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with(&format!("https://github.com/{REPO}")) {
        return Err("endereço não permitido".to_string());
    }
    Command::new("explorer.exe").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---- Mec Encoder (opcional): ele observa uma pasta de tarefas. Com "start": false (Mec Encoder 0.3.12+)
// os arquivos entram na fila e ficam parados, esperando a pessoa mandar converter. ----
fn mecenc_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("com.hugomec.mecencoder")
}
fn mecenc_exe() -> PathBuf {
    PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default()).join("Mec Encoder").join("mec-encoder.exe")
}

/// Diz se o Mec Encoder está neste PC e quais predefinições de vídeo ele tem.
#[tauri::command]
fn mecenc_info() -> Value {
    let dir = mecenc_dir();
    let read = |name: &str| fs::read_to_string(dir.join(name)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let all = read("presets.json").and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let name_of = |p: &Value| p.get("name").and_then(Value::as_str).map(str::to_string);
    let presets: Vec<String> = all.iter().filter(|p| p.get("kind").and_then(Value::as_str) == Some("video")).filter_map(name_of).collect();
    // nas configurações do Mec Encoder a predefinição padrão vem pelo id; aqui devolvemos o nome
    let default_id = read("settings.json").and_then(|v| v.get("defaultPreset").and_then(Value::as_str).map(str::to_string));
    let default = default_id.and_then(|id| all.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id.as_str())).and_then(name_of));
    // versões antigas ignoram "start" e converteriam na hora: só oferecemos a opção se o LEIA-ME da pasta citar o campo
    let queue_only = fs::read_to_string(dir.join("jobs").join("README.txt")).map(|t| t.contains("\"start\"")).unwrap_or(false);
    json!({ "installed": dir.join("jobs").is_dir(), "queueOnly": queue_only, "presets": presets, "defaultPreset": default })
}

/// Coloca os arquivos na fila do Mec Encoder, sem converter, e abre o app se estiver fechado.
#[tauri::command]
fn mecenc_send(files: Vec<String>, preset: String) -> Result<String, String> {
    let jobs = mecenc_dir().join("jobs");
    if !jobs.is_dir() {
        return Err("o Mec Encoder não foi encontrado neste PC".to_string());
    }
    if files.is_empty() {
        return Err("nenhum vídeo para enviar".to_string());
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let name = format!("mecdrive-{stamp}.json");
    let body = serde_json::to_vec_pretty(&json!({ "files": files, "preset": preset, "start": false })).map_err(|e| e.to_string())?;
    // grava com outro nome e renomeia, para o Mec Encoder nunca ler um arquivo pela metade
    let tmp = jobs.join(format!("{name}.tmp"));
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, jobs.join(&name)).map_err(|e| e.to_string())?;
    let running = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq mec-encoder.exe", "/NH"])
        .creation_flags(NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("mec-encoder.exe"))
        .unwrap_or(false);
    if !running && mecenc_exe().exists() {
        let _ = Command::new(mecenc_exe()).spawn();
    }
    Ok(name)
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Luzes do quarto: verde quando termina, vermelho quando precisa do usuário.
#[tauri::command]
fn alerta(color: String) {
    if color != "green" && color != "red" {
        return;
    }
    let script = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".claude").join("hooks").join("alerta.py");
    if script.exists() {
        let _ = Command::new("python").arg(script).arg(color).creation_flags(NO_WINDOW).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    }
}

fn main() {
    let state = AppState { root: shared::find_root(), rcd: Mutex::new(None), login_pid: Mutex::new(None), job: JobHandle::new() };
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            app_info,
            rcd_start,
            rc,
            rcd_pause,
            google_login,
            google_login_cancel,
            google_logout,
            drive_get,
            list_dirs,
            stat_files,
            clean_partials,
            read_json,
            write_json,
            pick_folder,
            open_folder,
            disk_free,
            reveal,
            check_update,
            open_url,
            mecenc_info,
            mecenc_send,
            notify,
            alerta
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o MecDrive")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                if let Some(pid) = state.login_pid.lock().unwrap().take() {
                    kill_pid(pid, true);
                }
                stop_rcd(&state);
            }
        });
}
