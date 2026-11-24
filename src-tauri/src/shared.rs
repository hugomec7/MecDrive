// Código comum ao app (main.rs) e à linha de comando (bin/mecdrive-cli.rs).
#![allow(dead_code)]

use serde_json::Value;
use std::ffi::c_void;
use std::fs;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::Duration;

pub const NO_WINDOW: u32 = 0x0800_0000;
pub const REMOTE: &str = "gdrive";
pub const REPO: &str = "hugomec7/MecDrive";

/// Pasta do app: a do exe, ou a primeira acima dela que tenha bin/rclone.exe (build de desenvolvimento).
pub fn find_root() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let start = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut dir = start.clone();
    for _ in 0..5 {
        if dir.join("bin").join("rclone.exe").exists() {
            return dir;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    start
}

/// Onde ficam token, histórico e configuração. Versão portátil: pasta `data` ao lado do exe.
/// Versão instalada (sem essa pasta): %APPDATA%\MecDrive.
pub fn data_dir(root: &Path) -> PathBuf {
    let local = root.join("data");
    if local.is_dir() {
        return local;
    }
    match std::env::var("APPDATA") {
        Ok(a) if !a.is_empty() => PathBuf::from(a).join("MecDrive"),
        _ => local,
    }
}

pub fn rclone_exe(root: &Path) -> PathBuf {
    root.join("bin").join("rclone.exe")
}

pub fn has_token(conf: &Path) -> bool {
    let c = fs::read_to_string(conf).unwrap_or_default();
    c.contains("[gdrive]") && c.contains("access_token")
}

fn read_token(conf: &Path) -> Option<String> {
    let conf = fs::read_to_string(conf).ok()?;
    let json = conf
        .lines()
        .find_map(|l| l.trim().strip_prefix("token").map(|r| r.trim_start().trim_start_matches('=').trim().to_string()))?;
    serde_json::from_str::<Value>(&json).ok()?.get("access_token")?.as_str().map(str::to_string)
}

/// Consulta só de leitura à API do Drive com o token do rclone (nome do item do link, e-mail da conta).
pub fn drive_get(conf: &Path, query: &str, resource_key: Option<&str>) -> Result<Value, String> {
    if !(query.starts_with("files/") || query.starts_with("about?")) {
        return Err("consulta não permitida".to_string());
    }
    let token = read_token(conf).ok_or_else(|| "sem login".to_string())?;
    let mut req = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build()
        .get(&format!("https://www.googleapis.com/drive/v3/{query}"))
        .set("Authorization", &format!("Bearer {token}"));
    if let Some(k) = resource_key.filter(|k| !k.is_empty()) {
        req = req.set("X-Goog-Drive-Resource-Keys", k);
    }
    match req.call() {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, resp)) => {
            let body: Value = resp.into_json().unwrap_or(Value::Null);
            let reason = body.pointer("/error/errors/0/reason").and_then(Value::as_str).unwrap_or("");
            Err(format!("HTTP {code} {reason}").trim().to_string())
        }
        Err(e) => Err(format!("sem conexão: {e}")),
    }
}

/// Troca o que o Windows não aceita em nomes por caracteres permitidos (a mesma regra está em ui/app.js):
/// barras, dois-pontos e barra vertical viram hífen, aspas viram apóstrofo, < > viram parênteses,
/// ? e * somem, e espaço ou ponto no fim do nome é cortado.
pub fn clean_segment(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            '/' | '／' | '\\' | '＼' | ':' | '：' | '|' | '｜' => out.push('-'),
            '"' | '＂' => out.push('\''),
            '<' | '＜' => out.push('('),
            '>' | '＞' => out.push(')'),
            '?' | '？' | '*' | '＊' => {}
            c if (c as u32) < 32 => {}
            c => out.push(c),
        }
    }
    let t = out.trim_end_matches([' ', '.']).trim_start_matches(' ');
    if t.is_empty() { "_".to_string() } else { t.to_string() }
}

/// Aplica `clean_segment` a cada parte de um caminho relativo separado por `/`.
pub fn clean_rel(rel: &str) -> String {
    rel.split('/').filter(|p| !p.is_empty()).map(clean_segment).collect::<Vec<_>>().join("/")
}

// ---- Job Object: tudo que o processo inicia (rclone) morre junto com ele, mesmo se for encerrado à força ----
#[repr(C)]
struct JobBasicLimits {
    per_process_time: i64,
    per_job_time: i64,
    limit_flags: u32,
    min_ws: usize,
    max_ws: usize,
    active_limit: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}
#[repr(C)]
struct JobExtendedLimits {
    basic: JobBasicLimits,
    io: [u64; 6],
    process_mem: usize,
    job_mem: usize,
    peak_process: usize,
    peak_job: usize,
}
#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
}
pub struct JobHandle(*mut c_void);
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl JobHandle {
    pub fn new() -> JobHandle {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if !job.is_null() {
                let mut info: JobExtendedLimits = std::mem::zeroed();
                info.basic.limit_flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                SetInformationJobObject(job, 9, &info as *const _ as *const c_void, std::mem::size_of::<JobExtendedLimits>() as u32);
            }
            JobHandle(job)
        }
    }
    pub fn assign(&self, child: &Child) {
        if !self.0.is_null() {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as *mut c_void) };
        }
    }
}
