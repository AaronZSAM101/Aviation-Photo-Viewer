//! 彩绘提醒：把「今天有哪班彩绘机要来」搬到相册里。
//!
//! 数据源是朋友那套 AIRFRAME 站点的 `/api/schedule`（整站要访问密码），
//! 或者任何返回同一份 JSON 形状的地址。这里只做只读消费：不上传照片、不写回他的库。
//! 读不到就照实说「读不到」，并把上一次成功的结果标着「旧数据」留下，别让用户以为今天没飞机。
//!
//! 分类口径跟着他的 `photoFlight()`：数据源标的彩绘目标 / 本地记过的彩绘 / 特色机型清单 /
//! 自己的关注，四条来源哪个先对上就叫什么。

use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, time::SystemTime};
use tokio::fs;

use crate::{
    cache_paths,
    models::{AppState, WatchItem},
};

/// 数据源拉一次能用 5 分钟，和他站内的快照保鲜期一致
const FEED_TTL_SECS: i64 = 300;

/// 特色机型清单，照抄 AIRFRAME 的 `specialTypes`
const SPECIAL_TYPES: &[(&str, &str)] = &[
    ("A388", "空客 A380"),
    ("B744", "波音 747-400"),
    ("B748", "波音 747-8"),
    ("MD11", "麦道 MD-11"),
    ("A124", "安东诺夫 An-124"),
    ("IL76", "伊尔 Il-76"),
    ("A3ST", "空客 Beluga"),
    ("A337", "空客 BelugaXL"),
    ("C919", "中国商飞 C919"),
];

/// 这些值在航班数据里表示「还没排机」，不能当机号用
const NOT_A_REGISTRATION: &[&str] = &[
    "NA", "N/A", "NONE", "NULL", "UNDEFINED", "UNKNOWN", "TBD", "TBA", "PENDING",
];

/// 数据源会把「首架/不载旗」这类也算进 providerTarget，那不是彩绘
const NOT_A_LIVERY: &[&str] = &["首架", "首个", "不载旗", "无国旗"];

pub fn special_type(model: &str) -> Option<&'static str> {
    SPECIAL_TYPES
        .iter()
        .find(|(code, _)| *code == model.trim().to_uppercase())
        .map(|(_, name)| *name)
}

/// 照抄 AIRFRAME 的 `normalizeRegistration`：去空格、大写、剔除占位值，
/// 长度 3～16 且只允许字母数字和连字符。
pub fn normalize_registration(value: Option<&str>) -> Option<String> {
    let raw = value?.trim().to_uppercase().replace(' ', "");
    if raw.is_empty() || NOT_A_REGISTRATION.contains(&raw.as_str()) {
        return None;
    }
    let bytes = raw.as_bytes();
    if bytes.len() < 3 || bytes.len() > 16 {
        return None;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return None;
    }
    if !bytes[1..]
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || *c == b'-')
    {
        return None;
    }
    Some(raw)
}

fn same_registration(a: &str, b: &str) -> bool {
    a.replace('-', "") == b.replace('-', "")
}

/// 一架机在提醒清单里的样子：航班信息 + 这条是按哪条规则命中的
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertFlight {
    pub flight_number: String,
    pub registration: Option<String>,
    pub model: String,
    pub airline: String,
    pub origin: String,
    pub destination: String,
    /// arrival = 落地这个机场，departure = 从这个机场走
    pub direction: String,
    pub scheduled_at: Option<String>,
    pub status: String,
    pub source: String,
    pub name: String,
    pub category: &'static str,
    pub provider_target: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFlight {
    #[serde(default)]
    flight_number: String,
    #[serde(default)]
    registration: Option<String>,
    #[serde(default)]
    model: String,
    #[serde(default)]
    airline: String,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    destination: String,
    #[serde(default)]
    direction: String,
    #[serde(default)]
    scheduled_at: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    provider_target: Option<String>,
    #[serde(default)]
    demo_livery: Option<String>,
}

/// 分类：哪条来源先对上就叫什么，和他的 `photoFlight()` 同一套优先级
fn classify(flight: &RawFlight, watch: Option<&WatchItem>) -> (&'static str, String) {
    let provider_target = flight
        .provider_target
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let demo = flight
        .demo_livery
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let documented = watch.map(|w| w.documented).unwrap_or(false);
    let provider_paint = provider_target
        .map(|t| !NOT_A_LIVERY.iter().any(|needle| t.contains(needle)))
        .unwrap_or(false);
    let special = special_type(&flight.model);
    let conflict = provider_target.is_some() && watch.is_some() && !documented;

    let category = if conflict {
        "待核对"
    } else if demo.is_some() || documented || (provider_paint && flight.model != "C919") {
        "彩绘"
    } else if special.is_some() {
        "特色机型"
    } else if watch.is_some() {
        "我的关注"
    } else if flight.source.starts_with("Jetmark") {
        "拍摄推荐"
    } else {
        "其他航班"
    };
    let name = demo
        .or(provider_target)
        .or(watch.map(|w| w.name.as_str()))
        .or(special)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| if flight.model.is_empty() { "机型待定" } else { flight.model.as_str() })
        .to_string();
    (category, name)
}

/// 把「YYYY-MM-DDTHH:MM:SS(Z | ±HH:MM | 不带时区)」换成 epoch 秒，只为排序用。
/// 不拉 chrono：这里不需要解析任意格式，也不要它多一万行依赖。
fn epoch_of(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || !bytes[0..4].iter().all(u8::is_ascii_digit)
        || bytes[4] != b'-'
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || bytes[7] != b'-'
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
        || (bytes[10] != b'T' && bytes[10] != b' ')
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || bytes[13] != b':'
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let year: i64 = value[0..4].parse().ok()?;
    let month: i64 = value[5..7].parse().ok()?;
    let day: i64 = value[8..10].parse().ok()?;
    let hour: i64 = value[11..13].parse().ok()?;
    let minute: i64 = value[14..16].parse().ok()?;
    // days_from_civil（Howard Hinnant），和 chrono_free_today 互为逆运算
    let y = year - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    // 第 16～18 位是秒，时区标记从第 19 位开始；不带时区就当本地时间，只用来排序无所谓
    let offset = match bytes.get(19) {
        None | Some(b'Z') | Some(b'.') => 0,
        Some(mark) if *mark == b'+' || *mark == b'-' => {
            let sign = if *mark == b'-' { -1 } else { 1 };
            let oh: i64 = value.get(20..22)?.parse().ok()?;
            let om: i64 = value.get(23..25)?.parse().ok()?;
            sign * (oh * 3600 + om * 60)
        }
        _ => 0,
    };
    Some(days * 86_400 + hour * 3600 + minute * 60 - offset)
}

fn sort_key(value: &AlertFlight) -> i64 {
    value
        .scheduled_at
        .as_deref()
        .and_then(epoch_of)
        .unwrap_or(i64::MAX)
}

fn alerts_from(raw: &[RawFlight], watchlist: &HashMap<String, WatchItem>) -> Vec<AlertFlight> {
    let mut out: Vec<AlertFlight> = raw
        .iter()
        .filter_map(|flight| {
            let reg = normalize_registration(flight.registration.as_deref());
            let watch = reg
                .as_ref()
                .and_then(|r| watchlist.get(r))
                .or_else(|| {
                    // 关注表里可能写的是带/不带横杠的另一种写法
                    reg.as_ref().and_then(|r| {
                        watchlist
                            .iter()
                            .find(|(key, _)| same_registration(key, r))
                            .map(|(_, item)| item)
                    })
                })
                .cloned();
            let (category, name) = classify(flight, watch.as_ref());
            if category == "其他航班" {
                return None;
            }
            Some(AlertFlight {
                flight_number: flight.flight_number.clone(),
                registration: reg,
                model: flight.model.clone(),
                airline: flight.airline.clone(),
                origin: flight.origin.clone(),
                destination: flight.destination.clone(),
                direction: flight.direction.clone(),
                scheduled_at: flight.scheduled_at.clone(),
                status: flight.status.clone(),
                source: flight.source.clone(),
                name,
                category,
                provider_target: flight.provider_target.clone(),
            })
        })
        .collect();
    // 按真实时刻排，不是按字符串：数据源里既有 +08:00 也有 Z，字符串顺序会排错
    out.sort_by_key(sort_key);
    out
}

/// 数据源配置只从环境变量来：密码不该进照片库那个会被同步的目录
pub struct FeedConfig {
    pub base: String,
    pub password: Option<String>,
    pub token: Option<String>,
}

fn env_text(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn feed_config() -> Option<FeedConfig> {
    let base = env_text("AIRFRAME_URL").or_else(|| env_text("LIVERY_FEED_URL"))?;
    Some(FeedConfig {
        base: base.trim_end_matches('/').to_string(),
        password: env_text("AIRFRAME_PASSWORD"),
        token: env_text("LIVERY_FEED_TOKEN"),
    })
}

pub fn feed_configured() -> bool {
    feed_config().is_some()
}

/// 默认机场：看哪座城市的排班是部署决定，不该写死在前端里。没配、或配得不像 IATA
/// 三字码就退回 SHA（AIRFRAME 自己的默认值）；前端也只把它当成「用户没自己选过」时的兜底。
pub fn default_airport() -> String {
    default_airport_from(env_text("LIVERY_DEFAULT_AIRPORT").as_deref())
}

fn default_airport_from(value: Option<&str>) -> String {
    value
        .map(|v| v.trim().to_ascii_uppercase())
        .filter(|v| valid_airport(v))
        .unwrap_or_else(|| "SHA".to_string())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// 一次数据源请求的结果，够界面决定「显示新数据 / 显示旧数据 / 直说读不到」
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedOutcome {
    pub state: &'static str,
    pub message: String,
    pub alerts: Vec<AlertFlight>,
    pub total_flights: usize,
    pub feed_source: String,
    pub retrieved_at: i64,
    pub stale: bool,
}

impl FeedOutcome {
    fn live(&self) -> bool {
        self.state == "ok"
    }
}

fn curl_base() -> std::process::Command {
    let mut cmd = std::process::Command::new("curl");
    cmd.arg("-sS")
        .arg("--max-time")
        .arg("25")
        .arg("-L")
        .arg("--max-redirs")
        .arg("3");
    cmd
}

/// 登录拿 cookie：他的站整站要密码，`/api/*` 没 cookie 直接 401 JSON。
/// 密码走 stdin，不进命令行（那样会在容器的进程列表里裸着）。
fn login_for_cookie(cfg: &FeedConfig) -> Option<String> {
    let body = format!("password={}", percent_encode(cfg.password.as_deref()?));
    let mut child = curl_base()
        .arg("-o")
        .arg("/dev/null")
        .arg("-D")
        .arg("-")
        .arg("-X")
        .arg("POST")
        .arg("-H")
        .arg("Content-Type: application/x-www-form-urlencoded")
        .arg("--data-binary")
        .arg("@-")
        .arg(format!("{}/access/login", cfg.base))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    {
        use std::io::Write;
        child.stdin.as_mut()?.write_all(body.as_bytes()).ok()?;
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let headers = String::from_utf8_lossy(&output.stdout).to_lowercase();
    for line in headers.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("set-cookie:") {
            let pair = rest.split(';').next().unwrap_or("").trim();
            if pair.contains('=') && !pair.ends_with('=') {
                return Some(pair.to_string());
            }
        }
    }
    None
}

/// 读排班 JSON。支持三种形状：AIRFRAME 的 `{state, plan:{flights}}`、
/// 裸的 `{flights:[...]}`、以及直接一个航班数组——别人改数据源时不用动这里。
async fn fetch_plan(cfg: &FeedConfig, airport: &str, day: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/schedule?airport={}&day={}", cfg.base, airport, day);
    let cookie = cfg.password.clone().and_then(|_| login_for_cookie(cfg));
    let mut cmd = curl_base();
    cmd.arg("-H").arg("Accept: application/json");
    if let Some(token) = cfg.token.as_deref() {
        cmd.arg("-H").arg(format!("Authorization: Bearer {}", token));
    }
    if let Some(jar) = cookie.as_deref() {
        cmd.arg("-H").arg(format!("Cookie: {}", jar));
    }
    let output = tokio::task::spawn_blocking(move || {
        cmd.arg(url).output().map_err(|e| format!("调用 curl 失败：{e}"))
    })
    .await
    .map_err(|e| format!("数据源任务崩了：{e}"))??;
    if !output.status.success() {
        return Err(format!(
            "读取数据源失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|e| format!("数据源返回的不是 JSON：{e}"))
}

fn plan_flights(value: &serde_json::Value) -> (Vec<RawFlight>, usize, Option<String>) {
    let flights_value = value
        .get("plan")
        .and_then(|plan| plan.get("flights"))
        .or_else(|| value.get("flights"))
        .or(if value.is_array() { Some(value) } else { None });
    let retrieved_at = value
        .get("plan")
        .and_then(|plan| plan.get("retrievedAt"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .get("plan")
                .and_then(|plan| plan.get("updatedAt"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string());
    let Some(flights_value) = flights_value else {
        return (Vec::new(), 0, retrieved_at);
    };
    let raw: Vec<RawFlight> = serde_json::from_value(flights_value.clone()).unwrap_or_default();
    let total = match value.get("plan").and_then(|plan| plan.get("flights")) {
        Some(list) => list.as_array().map(|a| a.len()).unwrap_or(raw.len()),
        _ => raw.len(),
    };
    (raw, total, retrieved_at)
}

/// 拉一次排班并分类。失败时回退到同机场同日期最后一次成功结果，标成 stale。
pub async fn load_feed(
    state: &web::Data<AppState>,
    airport: &str,
    day: &str,
    refresh: bool,
) -> FeedOutcome {
    let key = format!("{airport}/{day}");
    let cached = state.livery_feed.read().await.get(&key).cloned();
    if !refresh {
        if let Some(hit) = &cached {
            if hit.live() && now_secs() - hit.retrieved_at < FEED_TTL_SECS {
                return hit.clone();
            }
        }
    }
    let Some(cfg) = feed_config() else {
        return match cached {
            Some(old) => FeedOutcome { stale: true, state: "unconfigured", ..old },
            None => FeedOutcome {
                state: "unconfigured",
                message: "没有配置排班数据源（环境变量 AIRFRAME_URL / LIVERY_FEED_URL）".to_string(),
                alerts: Vec::new(),
                total_flights: 0,
                feed_source: String::new(),
                retrieved_at: 0,
                stale: false,
            },
        };
    };
    let watchlist = state.livery_watch.read().await.clone();
    let outcome = match fetch_plan(&cfg, airport, day).await {
        Ok(value) => {
            let (raw, total, _) = plan_flights(&value);
            if raw.is_empty() && total == 0 {
                let msg = value
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("数据源没给航班")
                    .to_string();
                FeedOutcome {
                    state: "empty",
                    message: msg,
                    alerts: Vec::new(),
                    total_flights: 0,
                    feed_source: cfg.base.clone(),
                    retrieved_at: now_secs(),
                    stale: false,
                }
            } else {
                let alerts = alerts_from(&raw, &watchlist);
                FeedOutcome {
                    state: "ok",
                    message: format!("{airport} · {day}，共 {total} 班"),
                    alerts,
                    total_flights: total,
                    feed_source: cfg.base.clone(),
                    retrieved_at: now_secs(),
                    stale: false,
                }
            }
        }
        Err(e) => match cached {
            Some(old) => FeedOutcome {
                stale: true,
                state: "stale",
                message: format!("读不到最新数据（{e}），下面这份是之前留下的"),
                ..old
            },
            None => FeedOutcome {
                state: "error",
                message: e,
                alerts: Vec::new(),
                total_flights: 0,
                feed_source: cfg.base.clone(),
                retrieved_at: now_secs(),
                stale: false,
            },
        },
    };
    if outcome.live() {
        state
            .livery_feed
            .write()
            .await
            .insert(key, outcome.clone());
    }
    outcome
}

pub async fn load_watchlist(path: &Path) -> HashMap<String, WatchItem> {
    match fs::read_to_string(path).await {
        Ok(text) => serde_json::from_str::<HashMap<String, WatchItem>>(&text).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// 关注表是手写的，写坏了没法从别处重建，所以照旧走临时文件换名
pub async fn persist_watchlist(
    path: &Path,
    snapshot: &HashMap<String, WatchItem>,
) -> Result<(), String> {
    let buf =
        serde_json::to_vec_pretty(snapshot).map_err(|e| format!("序列化关注表失败：{e}"))?;
    let tmp = path.with_file_name(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("watchlist.json")
    ));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("建关注表目录失败：{e}"))?;
    }
    fs::write(&tmp, &buf)
        .await
        .map_err(|e| format!("写关注表临时文件失败：{e}"))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("关注表换名失败：{e}"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedQuery {
    pub airport: String,
    #[serde(default)]
    pub day: Option<String>,
    #[serde(default)]
    pub refresh: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRequest {
    pub registration: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub note: String,
    #[serde(default = "default_documented")]
    pub documented: bool,
}

fn default_documented() -> bool {
    true
}

fn bad_request(text: &str) -> HttpResponse {
    HttpResponse::BadRequest().json(serde_json::json!({ "error": text }))
}

/// 机场三字码和日期都要拼进 URL，所以先卡死格式，不接受任何别的字符
fn valid_airport(airport: &str) -> bool {
    let b = airport.as_bytes();
    b.len() == 3 && b.iter().all(|c| c.is_ascii_alphabetic())
}

fn valid_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    bytes.len() == 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

pub async fn list_watchlist(state: web::Data<AppState>) -> HttpResponse {
    let items: Vec<serde_json::Value> = {
        let guard = state.livery_watch.read().await;
        let mut pairs: Vec<_> = guard.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        pairs
            .into_iter()
            .map(|(reg, item)| {
                serde_json::json!({
                    "registration": reg,
                    "name": item.name,
                    "note": item.note,
                    "documented": item.documented,
                })
            })
            .collect()
    };
    HttpResponse::Ok().json(serde_json::json!({
        "items": items,
        "feedConfigured": feed_configured(),
    }))
}

pub async fn add_watch(state: web::Data<AppState>, req: web::Json<WatchRequest>) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }
    let Some(reg) = normalize_registration(Some(req.registration.as_str())) else {
        return bad_request("机号看起来不对，写「B-5487」这样就行");
    };
    if req.name.trim().is_empty() {
        return bad_request("给这台机起个名字，不然提醒里认不出");
    }
    let item = WatchItem {
        name: req.name.trim().to_string(),
        note: req.note.trim().to_string(),
        documented: req.documented,
    };
    let photos_dir = state.photos_dir.read().await.clone();
    let generation = state.dir_generation.load(std::sync::atomic::Ordering::SeqCst);
    let count = {
        let mut guard = state.livery_watch.write().await;
        guard.insert(reg.clone(), item.clone());
        guard.len()
    };
    if state
        .dir_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        == generation
    {
        let snapshot = state.livery_watch.read().await.clone();
        if let Err(e) =
            persist_watchlist(&cache_paths::watchlist(&photos_dir), &snapshot).await
        {
            tracing::warn!("关注表落盘失败：{e}");
        }
    }
    HttpResponse::Ok().json(serde_json::json!({
        "ok": true, "registration": reg, "count": count,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWatchRequest {
    pub registration: String,
}

pub async fn remove_watch(
    state: web::Data<AppState>,
    req: web::Json<RemoveWatchRequest>,
) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }
    let Some(reg) = normalize_registration(Some(req.registration.as_str())) else {
        return bad_request("机号看起来不对");
    };
    let photos_dir = state.photos_dir.read().await.clone();
    let generation = state.dir_generation.load(std::sync::atomic::Ordering::SeqCst);
    let removed = state.livery_watch.write().await.remove(&reg).is_some();
    if removed
        && state
            .dir_generation
            .load(std::sync::atomic::Ordering::SeqCst)
            == generation
    {
        let snapshot = state.livery_watch.read().await.clone();
        if let Err(e) =
            persist_watchlist(&cache_paths::watchlist(&photos_dir), &snapshot).await
        {
            tracing::warn!("关注表落盘失败：{e}");
        }
    }
    HttpResponse::Ok().json(serde_json::json!({ "ok": true, "removed": removed }))
}

pub async fn feed(state: web::Data<AppState>, query: web::Query<FeedQuery>) -> HttpResponse {
    let airport = query.airport.trim().to_uppercase();
    if !valid_airport(&airport) {
        return bad_request("机场要是三字码，例如 SZX");
    }
    let today = chrono_free_today();
    let day = query.day.clone().unwrap_or_else(|| today.clone());
    if !valid_day(&day) {
        return bad_request("日期要是 YYYY-MM-DD");
    }
    let outcome = load_feed(&state, &airport, &day, query.refresh.unwrap_or(false)).await;
    HttpResponse::Ok().json(outcome)
}

/// 今天（本地时区）的 YYYY-MM-DD。不想为这一个格式化拉 chrono，手写。
fn chrono_free_today() -> String {
    let secs = now_secs();
    let days = secs.div_euclid(86_400);
    // civil_from_days（Howard Hinnant 的算法），只用来把 epoch 天数换成年月日
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flight(reg: Option<&str>, model: &str, target: Option<&str>) -> RawFlight {
        RawFlight {
            flight_number: "NH0958".into(),
            registration: reg.map(String::from),
            model: model.into(),
            airline: "全日空".into(),
            origin: "HND".into(),
            destination: "SZX".into(),
            direction: "arrival".into(),
            scheduled_at: Some("2026-10-27T09:05:00+08:00".into()),
            status: "计划".into(),
            source: "Jetmark".into(),
            provider_target: target.map(String::from),
            demo_livery: None,
        }
    }

    fn watch(name: &str, documented: bool) -> WatchItem {
        WatchItem {
            name: name.into(),
            note: String::new(),
            documented,
        }
    }

    #[test]
    fn registration_normalisation_matches_the_source_rules() {
        assert_eq!(normalize_registration(Some(" b 52dx ")).as_deref(), Some("B52DX"));
        assert_eq!(normalize_registration(Some("B-5487")).as_deref(), Some("B-5487"));
        for junk in ["", "NA", "N/A", "unknown", "TBD", "AB", "ABCDEFGHIJKLMNOPQ", "B_52"] {
            assert_eq!(normalize_registration(Some(junk)), None, "{junk}");
        }
        // 上限这边是收的：16 个字符算合法（他的正则整体 3～16）
        assert_eq!(
            normalize_registration(Some("ABCDEFGHIJKLMNOP")).as_deref(),
            Some("ABCDEFGHIJKLMNOP")
        );
    }

    #[test]
    fn categories_follow_the_same_precedence() {
        let empty: HashMap<String, WatchItem> = HashMap::new();

        // 数据源说这是彩绘目标 → 彩绘
        let painted = alerts_from(
            &[flight(Some("JA381A"), "A388", Some("FLYING HONU"))],
            &empty,
        );
        assert_eq!(painted[0].category, "彩绘");
        assert_eq!(painted[0].name, "FLYING HONU");

        // 「首架」这类目标不算彩绘，但 A388 本身在特色机型清单里；
        // 名字照旧用数据源给的那句——他的界面也是这么显示的，两边对得上才好沟通
        let first = alerts_from(&[flight(Some("JA381A"), "A388", Some("首架交付"))], &empty);
        assert_eq!(first[0].category, "特色机型");
        assert_eq!(first[0].name, "首架交付");

        // 记过名字但没确认 → 待核对，名字仍用数据源给的那个
        let mut watchlist = HashMap::new();
        watchlist.insert("JA381A".to_string(), watch("我的海龟", false));
        let pending = alerts_from(&[flight(Some("JA381A"), "A388", Some("绿色海龟"))], &watchlist);
        assert_eq!(pending[0].category, "待核对");
        assert_eq!(pending[0].name, "绿色海龟");

        // 确认过的彩绘，数据源没提也算
        let mut watchlist = HashMap::new();
        watchlist.insert("B-5487".to_string(), watch("侏罗纪世界", true));
        let mine = alerts_from(&[flight(Some("B5487"), "B738", None)], &watchlist);
        assert_eq!(mine[0].category, "彩绘");
        assert_eq!(mine[0].name, "侏罗纪世界");

        // 只有关注、机型普通 → 我的关注
        let mut watchlist = HashMap::new();
        watchlist.insert("B-1234".to_string(), watch("同事的机", false));
        let watched = alerts_from(&[flight(Some("B-1234"), "B738", None)], &watchlist);
        assert_eq!(watched[0].category, "我的关注");

        // 没机号、机型普通、数据源是 Jetmark → 拍摄推荐
        let recommended = alerts_from(&[flight(None, "B738", None)], &empty);
        assert_eq!(recommended[0].category, "拍摄推荐");

        // 换一家数据源，同样的航班就什么都不是，不该冒出来
        let mut plain = flight(None, "B738", None);
        plain.source = "VariFlight".into();
        assert!(alerts_from(&[plain], &empty).is_empty());
    }

    #[test]
    fn c919_paint_claim_from_the_provider_stays_a_special_type() {
        // 他那边对 C919 有个例外：新机型本身就值得拍，providerTarget 的说法不升级为彩绘
        let empty: HashMap<String, WatchItem> = HashMap::new();
        let c919 = alerts_from(&[flight(Some("B-919A"), "C919", Some("彩绘交付"))], &empty);
        assert_eq!(c919[0].category, "特色机型");
    }

    #[test]
    fn alerts_are_ordered_by_scheduled_time_with_unknown_last() {
        let empty: HashMap<String, WatchItem> = HashMap::new();
        let mut late = flight(Some("B-1111"), "A388", None);
        late.scheduled_at = Some("2026-10-27T18:00:00+08:00".into());
        let mut early = flight(Some("B-2222"), "A388", None);
        early.scheduled_at = Some("2026-10-27T07:00:00+08:00".into());
        // 02:00Z 比 07:00+08:00 晚，但字符串顺序会把它排在最前
        let mut zulu = flight(Some("B-4444"), "A388", None);
        zulu.scheduled_at = Some("2026-10-27T02:00:00Z".into());
        let mut unknown = flight(Some("B-3333"), "A388", None);
        unknown.scheduled_at = None;
        let list = alerts_from(&[late, early, unknown, zulu], &empty);
        assert_eq!(
            list
                .iter()
                .map(|f| f.registration.as_deref().unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["B-2222", "B-4444", "B-1111", "B-3333"]
        );
        assert_eq!(list.last().unwrap().registration.as_deref(), Some("B-3333"));
    }

    #[test]
    fn feed_input_shapes_are_all_understood() {
        let airframe = serde_json::json!({
            "state": "connected",
            "configured": true,
            "message": "",
            "plan": {
                "airport": "SZX", "day": "2026-10-27", "source": "Jetmark",
                "retrievedAt": "2026-10-27T06:00:00Z",
                "flights": [{ "flightNumber": "NH0958", "registration": "JA381A", "model": "A388",
                              "direction": "arrival", "origin": "HND", "destination": "SZX",
                              "scheduledAt": "2026-10-27T09:05:00+08:00", "source": "Jetmark",
                              "providerTarget": "FLYING HONU" }]
            }
        });
        let (raw, total, retrieved) = plan_flights(&airframe);
        assert_eq!(raw.len(), 1);
        assert_eq!(total, 1);
        assert_eq!(retrieved.as_deref(), Some("2026-10-27T06:00:00Z"));

        let bare = serde_json::json!({ "flights": [{ "flightNumber": "CZ0001" }] });
        assert_eq!(plan_flights(&bare).0.len(), 1);

        let list = serde_json::json!([{ "flightNumber": "CZ0002" }]);
        assert_eq!(plan_flights(&list).0.len(), 1);

        let nothing = serde_json::json!({ "state": "unavailable", "plan": null, "message": "没配 key" });
        assert_eq!(plan_flights(&nothing).0.len(), 0);
    }

    #[test]
    fn day_and_airport_formats_are_strict_because_they_reach_the_url() {
        assert!(valid_airport("SZX"));
        assert!(valid_airport("szx"));
        assert!(!valid_airport("SZX1"));
        assert!(!valid_airport("S Z"));
        assert!(valid_day("2026-10-27"));
        assert!(!valid_day("2026-10"));
        assert!(!valid_day("2026-10-27; rm -rf"));
    }

    #[test]
    fn today_formats_as_a_plain_iso_date() {
        let today = chrono_free_today();
        assert!(valid_day(&today), "{today}");
        assert!(today.as_str()[0..4].parse::<i32>().unwrap() >= 2026);
    }

    #[test]
    fn passwords_are_encoded_before_they_reach_the_form_body() {
        assert_eq!(percent_encode("a b&c"), "a%20b%26c");
        assert_eq!(percent_encode("p@ssw0rd-_.~"), "p%40ssw0rd-_.~");
    }

    #[tokio::test]
    async fn watchlist_round_trips_through_its_own_file() {
        let dir = std::env::temp_dir().join(format!("pv-watch-{}", std::process::id()));
        let file = dir.join("watchlist.json");
        let mut map = HashMap::new();
        map.insert("JA381A".to_string(), watch("FLYING HONU", true));
        persist_watchlist(&file, &map).await.expect("write");
        let back = load_watchlist(&file).await;
        assert_eq!(back.get("JA381A").map(|w| w.name.as_str()), Some("FLYING HONU"));
        assert!(back.get("JA381A").unwrap().documented);
        let _ = fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn missing_watchlist_loads_as_empty() {
        let map = load_watchlist(&std::env::temp_dir().join("pv-watch-definitely-absent.json")).await;
        assert!(map.is_empty());
    }

    #[test]
    fn default_airport_follows_env_but_only_three_letter_codes() {
        assert_eq!(default_airport_from(None), "SHA");
        assert_eq!(default_airport_from(Some("  szx ")), "SZX");
        assert_eq!(default_airport_from(Some("")), "SHA");
        assert_eq!(default_airport_from(Some("SZX?x=1")), "SHA");
    }
}
