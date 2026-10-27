//! 从文件名里提取机号。
//!
//! 这个图库的命名习惯是“机号在前，后缀在后”：`B-30F9-20260606.jpg`、`VH-VEZ-L.jpg`、
//! `JA383A-20250611.jpg`，同框两架用 `&` 连（`B-1357&B-1566.jpg`），军机则直接写编号
//! （`61349-20230726.jpg`、`歼11-70065.jpg`、`09（八一）.jpg`）。
//! 解析只做“文件名里明写着什么”的提取，认不出来的就留空，交给 OCR 或人工补——
//! 宁可漏，也不要给一张机场全景图安上机号。
//!
//! 输出保持原样的分隔形态（`N719AN` 不加横杠，`B-1357` 保留横杠），
//! 比对时用 [`normalize`] 去掉横杠和大小写差异。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::models::DetectedReg;

/// 真实存在的一个字母国籍前缀（中国 B、加拿大 C、德国 D、法国 F、英国 G、意大利 I、
/// 马恩岛 M、美国 N）。像 `ZSAM`、`YSSY` 这种四位机场代码正因为前缀不在这里而不会被
/// 误当成机号。
const ONE_LETTER_PREFIXES: &[char] = &['B', 'C', 'D', 'F', 'G', 'I', 'M', 'N'];

/// 文件名里能认出的机号，按出现顺序去重，最多 4 个。
pub fn from_filename(name: &str) -> Vec<String> {
    let stem = std::path::Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let mut out: Vec<String> = Vec::new();
    for seg in stem.split(['&', '+', '＋']) {
        if let Some(reg) = leading(seg) {
            if !out.iter().any(|r| normalize(r) == normalize(&reg)) {
                out.push(reg);
            }
        }
        if out.len() >= 4 {
            break;
        }
    }
    out
}

/// 比对用的形状：大写、只留字母数字。
pub fn normalize(reg: &str) -> String {
    reg.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_uppercase())
        .collect()
}

fn leading(raw: &str) -> Option<String> {
    let seg = raw.trim_start_matches(|c: char| c.is_whitespace() || c == '_' || c == '-');
    let chars: Vec<char> = seg.chars().collect();
    if chars.is_empty() {
        return None;
    }
    cjk_number(&chars).or_else(|| civil(&chars)).or_else(|| number(&chars))
}

/// 中文机型打头时，取它后面的编号：`歼11-70065` → 70065，`教8-15` → 15。
fn cjk_number(chars: &[char]) -> Option<String> {
    let mut i = 0;
    while i < chars.len() && !chars[i].is_ascii() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let rest = &chars[i..];
    let (type_digits, j) = digit_run(rest, 0);
    if (1..=3).contains(&type_digits.len()) && j < rest.len() && rest[j] == '-' {
        let (num, k) = digit_run(rest, j + 1);
        if (2..=6).contains(&num.len()) && boundary(rest, k) {
            return Some(num);
        }
    }
    let (num, k) = digit_run(rest, 0);
    if (2..=6).contains(&num.len()) && boundary(rest, k) {
        return Some(num);
    }
    None
}

/// 民航注册号：`B-1357`、`VH-TQG`、`9M-MNM`、`JA383A`、`N719AN`。
fn civil(chars: &[char]) -> Option<String> {
    for plen in [3usize, 2, 1] {
        if chars.len() < plen {
            continue;
        }
        let pre: String = chars[..plen].iter().flat_map(|c| c.to_uppercase()).collect();
        if !pre.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        if plen == 1 && !ONE_LETTER_PREFIXES.contains(&pre.chars().next().unwrap()) {
            continue;
        }
        // 三字母打头一律要带数字，否则 `DSC_1234`、`IXP_9475` 这类相机自命名会被当成前缀
        if plen == 3 && pre.chars().all(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        let sep = chars.get(plen).copied();
        // 下划线不算分隔符：`_MG_8790`、`DSC_1234` 这种自命名里它无处不在
        if matches!(sep, Some('-') | Some(' ')) {
            let (body, end) = alnum_run(chars, plen + 1);
            if (3..=5).contains(&body.len()) && boundary(chars, end) {
                return Some(format!("{}-{}", pre, body.to_uppercase()));
            }
        }
        let plain_prefix_ok = (plen == 2 && pre.chars().all(|c| c.is_ascii_alphabetic()))
            || (plen == 1 && ONE_LETTER_PREFIXES.contains(&pre.chars().next().unwrap()));
        if plain_prefix_ok {
            let (body, end) = alnum_run(chars, plen);
            if (3..=5).contains(&body.len())
                && body.chars().any(|c| c.is_ascii_digit())
                && boundary(chars, end)
            {
                return Some(format!("{}{}", pre, body.to_uppercase()));
            }
        }
    }
    None
}

/// 军机编号直接打头：`61349-20230726` → 61349，`09（八一）` → 09，`5040` → 5040。
fn number(chars: &[char]) -> Option<String> {
    let (digits, end) = digit_run(chars, 0);
    if digits.is_empty() || digits.len() > 6 || !boundary(chars, end) {
        return None;
    }
    // 孤零零的四位数若是 19xx/20xx，那是年份不是编号（八位日期已经被 6 位上限挡掉）
    if digits.len() == 4 && (digits.starts_with("19") || digits.starts_with("20")) {
        return None;
    }
    Some(digits)
}

fn digit_run(chars: &[char], from: usize) -> (String, usize) {
    let mut j = from;
    while j < chars.len() && chars[j].is_ascii_digit() {
        j += 1;
    }
    (chars[from..j].iter().collect(), j)
}

fn alnum_run(chars: &[char], from: usize) -> (String, usize) {
    let mut j = from;
    while j < chars.len() && chars[j].is_ascii_alphanumeric() {
        j += 1;
    }
    (chars[from..j].iter().collect(), j)
}

fn boundary(chars: &[char], at: usize) -> bool {
    at >= chars.len() || !chars[at].is_ascii_alphanumeric()
}

/// 识别出来的机号存这里：`.photo_viewer/reg_detect.json`
pub async fn load_detect(path: &Path) -> HashMap<String, DetectedReg> {
    match tokio::fs::read_to_string(path).await {
        Ok(text) => serde_json::from_str::<HashMap<String, DetectedReg>>(&text).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// 原子写：识别结果是一次性攒出来的，写坏了就全丢
pub async fn persist_detect(path: &Path, snapshot: &HashMap<String, DetectedReg>) -> Result<(), String> {
    let buf = serde_json::to_vec_pretty(snapshot)
        .map_err(|e| format!("序列化机号识别结果失败：{e}"))?;
    let tmp = path.with_file_name(format!(
        ".{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("reg_detect.json")
    ));
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("建机号缓存目录失败：{e}"))?;
    }
    tokio::fs::write(&tmp, &buf)
        .await
        .map_err(|e| format!("写机号缓存临时文件失败：{e}"))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("机号缓存换名失败：{e}"))?;
    Ok(())
}

/// OCR 用到多长的边：文字识别不需要原图，但也不能糊到认不出漆字
const OCR_MAX_EDGE: u32 = 1600;

/// 装了 tesseract 才有的能力，界面据此决定按钮点不点得动。
pub fn ocr_available() -> bool {
    static OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OK.get_or_init(|| {
        std::process::Command::new("tesseract")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// 对一张照片做机身文字识别，只返回认出来的机号形状。
/// 准确率天生不高（机身字是斜的、弯的、还常被机翼挡住），所以结果只补文件名
/// 读不出机号的空缺，并且由用户手动触发、逐张存证。
pub fn ocr_file(path: &Path) -> Result<Vec<String>, String> {
    let img = crate::decode::open_image(path).ok_or("图片读不出像素")?;
    let small = img.thumbnail(OCR_MAX_EDGE, OCR_MAX_EDGE);
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("photo")
        .to_ascii_lowercase()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "_");
    let tmp: PathBuf = std::env::temp_dir().join(format!("pv-ocr-{stem}-{}.png", std::process::id()));
    small
        .save(&tmp)
        .map_err(|e| format!("临时图片写不出来：{e}"))?;
    let text = std::process::Command::new("tesseract")
        .arg(&tmp)
        .arg("stdout")
        // psm 11 = 稀疏文字：机身号是画面里孤立的一小串字，不是整页文档
        .args(["--psm", "11"])
        .output()
        .map_err(|e| format!("调用 tesseract 失败：{e}"))?;
    let _ = std::fs::remove_file(&tmp);
    if !text.status.success() {
        return Err(format!(
            "tesseract 退出码 {:?}：{}",
            text.status.code(),
            String::from_utf8_lossy(&text.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&text.stdout).to_string();
    Ok(regs_from_text(&stdout))
}

/// 从 OCR 文本里挑出像机号的片段。OCR 会把 `B-20DX` 认成 `B20DX`、`B-200X` 之类，
/// 这里只保留结构上站得住的，形状对不对由用户判断。
pub fn regs_from_text(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in text.split(|c: char| c.is_whitespace() || c == '|' || c == ',') {
        let cleaned = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
        if cleaned.is_empty() {
            continue;
        }
        for reg in from_filename(cleaned) {
            if !out.iter().any(|r| normalize(r) == normalize(&reg)) {
                out.push(reg);
            }
        }
    }
    out.truncate(4);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(name: &str) -> Option<String> {
        from_filename(name).into_iter().next()
    }

    #[test]
    fn dashed_registrations() {
        // 库里最常见的三种写法：机号 + 日期、机号 + 视角后缀、机号裸名
        assert_eq!(one("B-30F9-20260606.jpg").as_deref(), Some("B-30F9"));
        assert_eq!(one("VH-VEZ-L.jpg").as_deref(), Some("VH-VEZ"));
        assert_eq!(one("VN-A894-R.jpg").as_deref(), Some("VN-A894"));
        assert_eq!(one("PK-GIF.jpg").as_deref(), Some("PK-GIF"));
        assert_eq!(one("HS-THV-20260606.jpg").as_deref(), Some("HS-THV"));
        assert_eq!(one("9M-MNM.jpg").as_deref(), Some("9M-MNM"));
        assert_eq!(one("4W-AAO-20250603.jpg").as_deref(), Some("4W-AAO"));
        assert_eq!(one("RP-C3508.jpg").as_deref(), Some("RP-C3508"));
    }

    #[test]
    fn plain_registrations_keep_their_shape() {
        assert_eq!(one("JA383A-20250611.jpg").as_deref(), Some("JA383A"));
        assert_eq!(one("HL8089.jpg").as_deref(), Some("HL8089"));
        assert_eq!(one("N719AN.jpg").as_deref(), Some("N719AN"));
        assert_eq!(one("N15969-R.jpg").as_deref(), Some("N15969"));
    }

    #[test]
    fn single_letter_prefixes_only_for_real_countries() {
        assert_eq!(one("B-HLT.jpg").as_deref(), Some("B-HLT"));
        assert_eq!(one("G-ZBKA.jpg").as_deref(), Some("G-ZBKA"));
        // Z / Y 不是任何国家的注册号前缀，它们是机场代码
        assert_eq!(from_filename("ZSAM-Overview.jpg"), Vec::<String>::new());
        assert_eq!(from_filename("YSSY-Overview.jpg"), Vec::<String>::new());
        assert_eq!(from_filename("ZSSS.jpg"), Vec::<String>::new());
    }

    #[test]
    fn two_aircraft_in_one_frame() {
        assert_eq!(from_filename("B-1357&B-1566.jpg"), vec!["B-1357", "B-1566"]);
        assert_eq!(from_filename("HB-FRI&HB-FRN.jpg"), vec!["HB-FRI", "HB-FRN"]);
    }

    #[test]
    fn military_numbers() {
        assert_eq!(one("61349-20230726.jpg").as_deref(), Some("61349"));
        assert_eq!(one("5040.jpg").as_deref(), Some("5040"));
        assert_eq!(one("1349-20220827.jpg").as_deref(), Some("1349"));
        assert_eq!(one("09-20230726（八一）.jpg").as_deref(), Some("09"));
        // 纯日期不是编号
        assert_eq!(from_filename("20230726.jpg"), Vec::<String>::new());
        assert_eq!(from_filename("1925.jpg"), Vec::<String>::new());
    }

    #[test]
    fn cjk_type_prefixes_yield_the_number() {
        assert_eq!(one("歼11-70065.jpg").as_deref(), Some("70065"));
        assert_eq!(one("教8-15.jpg").as_deref(), Some("15"));
        assert_eq!(one("红鹰教8-15.jpg").as_deref(), Some("15"));
        // 认不出编号的纯中文名字就留空
        assert_eq!(from_filename("红鹰编队.jpg"), Vec::<String>::new());
    }

    #[test]
    fn camera_generated_names_are_not_registrations() {
        assert_eq!(from_filename("DSC_1234.jpg"), Vec::<String>::new());
        assert_eq!(from_filename("IMG_4567-20230726.jpg"), Vec::<String>::new());
        assert_eq!(from_filename("_MG_8790.jpg"), Vec::<String>::new());
        assert_eq!(from_filename("ZSGZ-Terminal.jpg"), Vec::<String>::new());
        assert_eq!(from_filename("A30-Overview.jpg"), Vec::<String>::new());
    }

    #[test]
    fn normalization_folds_separators_and_case() {
        assert_eq!(normalize("n-719an"), "N719AN");
        assert_eq!(normalize("N719AN"), "N719AN");
        assert_eq!(normalize("B_1357"), "B1357");
    }

    #[test]
    fn extension_and_folder_do_not_matter() {
        assert_eq!(one("Queued/YSSY/B-5952-R.jpg").as_deref(), Some("B-5952"));
        assert_eq!(one("B-5952-R.JPG").as_deref(), Some("B-5952"));
        assert_eq!(one("B-5952").as_deref(), Some("B-5952"));
        assert_eq!(from_filename("noextension-xyz"), Vec::<String>::new());
    }

    #[test]
    fn ocr_text_keeps_registration_shapes() {
        // tesseract 常把横线吃掉，也常在结果里塞标点与换行
        assert_eq!(regs_from_text("B20DX\n"), vec!["B20DX".to_string()]);
        assert_eq!(regs_from_text("  B-20DX  "), vec!["B-20DX".to_string()]);
        assert_eq!(
            regs_from_text("CHINA\nSOUTHERN\nB-20DX\nAIRBUS A350\n"),
            vec!["B-20DX".to_string()]
        );
    }

    #[test]
    fn ocr_text_rejects_noise_that_is_not_a_registration() {
        // A 不在单字母国家白名单里，机型名因此不会被当成机号
        assert!(regs_from_text("AIRBUS A350 XWB").is_empty());
        assert!(regs_from_text("1234567890").is_empty());
        assert!(regs_from_text("").is_empty());
    }

    #[test]
    fn ocr_text_deduplicates_and_caps_the_guesses() {
        assert_eq!(regs_from_text("B-20DX b20dx B20DX"), vec!["B-20DX".to_string()]);
        assert_eq!(
            regs_from_text("N12345 N23456 N34567 N45678 N56789").len(),
            4,
            "识别文本再长也只给出有限几个候选"
        );
    }
}
