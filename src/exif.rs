use crate::models::ExifData;
use serde_json::Value;
use std::{path::Path, process::Command};

/// 将EXIF有理数转换为f64
fn rational_to_f64(r: &exif::Rational) -> f64 {
    if r.denom == 0 {
        0.0
    } else {
        r.num as f64 / r.denom as f64
    }
}

/// 提取GPS坐标
fn gps_coord(field: &exif::Field, ref_field: Option<&exif::Field>) -> Option<f64> {
    if let exif::Value::Rational(ref v) = field.value {
        if v.len() >= 3 {
            let deg = rational_to_f64(&v[0]);
            let min = rational_to_f64(&v[1]);
            let sec = rational_to_f64(&v[2]);
            let mut c = deg + min / 60.0 + sec / 3600.0;
            if let Some(rf) = ref_field {
                let s = rf.display_value().to_string();
                if s.contains('S') || s.contains('W') {
                    c = -c;
                }
            }
            return Some((c * 1_000_000.0).round() / 1_000_000.0);
        }
    }
    None
}

fn has_display_exif(d: &ExifData) -> bool {
    d.date_taken.is_some()
        || d.make.is_some()
        || d.model.is_some()
        || d.lens_model.is_some()
        || d.software.is_some()
        || d.iso.is_some()
        || d.exposure_time.is_some()
        || d.f_number.is_some()
        || d.focal_length.is_some()
        || d.focal_length_35mm.is_some()
        || d.gps_lat.is_some()
        || d.gps_lon.is_some()
        || d.flash.is_some()
        || d.white_balance.is_some()
        || d.metering_mode.is_some()
        || d.exposure_bias.is_some()
}

fn value_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn value_u32(v: &Value) -> Option<u32> {
    v.as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .or_else(|| v.as_str()?.trim().parse().ok())
}

fn value_f64(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.trim().parse().ok())
}

fn first_string(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| obj.get(*key).and_then(value_string))
}

fn first_u32(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .find_map(|key| obj.get(*key).and_then(value_u32))
}

fn first_f64(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| obj.get(*key).and_then(value_f64))
}

fn format_seconds(raw: String) -> String {
    if raw.contains('/') || raw.ends_with('s') {
        return raw;
    }

    match raw.parse::<f64>() {
        Ok(v) if v >= 1.0 => format!("{:.1}s", v),
        Ok(v) if v > 0.0 => format!("1/{}s", (1.0 / v).round() as u32),
        _ => raw,
    }
}

fn format_f_number(raw: String) -> String {
    if raw.starts_with("f/") {
        raw
    } else {
        match raw.parse::<f64>() {
            Ok(v) => format!("f/{:.1}", v),
            Err(_) => raw,
        }
    }
}

fn format_ev(raw: String) -> String {
    if raw.contains("EV") {
        raw
    } else {
        match raw.parse::<f64>() {
            Ok(v) => format!("{:+.1} EV", v),
            Err(_) => raw,
        }
    }
}

fn extract_exif_with_exiftool(path: &Path) -> Option<ExifData> {
    let output = Command::new("exiftool")
        .args([
            "-j",
            "-DateTimeOriginal",
            "-CreateDate",
            "-ModifyDate",
            "-Make",
            "-Model",
            "-LensModel",
            "-Lens",
            "-ISO",
            "-ExposureTime",
            "-FNumber",
            "-FocalLength",
            "-FocalLengthIn35mmFormat",
            "-ExifImageWidth",
            "-ExifImageHeight",
            "-ImageWidth",
            "-ImageHeight",
            "-GPSLatitude",
            "-GPSLongitude",
            "-Flash",
            "-WhiteBalance",
            "-MeteringMode",
            "-ExposureCompensation",
            "-Software",
        ])
        .arg(path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let docs: Vec<Value> = serde_json::from_slice(&output.stdout).ok()?;
    let obj = docs.first()?.as_object()?;
    let mut d = ExifData::default();

    d.date_taken = first_string(obj, &["DateTimeOriginal", "CreateDate", "ModifyDate"]);
    d.make = first_string(obj, &["Make"]);
    d.model = first_string(obj, &["Model"]);
    d.software = first_string(obj, &["Software"]);
    d.lens_model = first_string(obj, &["LensModel", "Lens"]);
    d.iso = first_string(obj, &["ISO"]);
    d.exposure_time = first_string(obj, &["ExposureTime"]).map(format_seconds);
    d.f_number = first_string(obj, &["FNumber"]).map(format_f_number);
    d.focal_length = first_string(obj, &["FocalLength"]);
    d.focal_length_35mm = first_string(obj, &["FocalLengthIn35mmFormat"]);
    d.image_width = first_u32(obj, &["ExifImageWidth", "ImageWidth"]);
    d.image_height = first_u32(obj, &["ExifImageHeight", "ImageHeight"]);
    d.gps_lat = first_f64(obj, &["GPSLatitude"]);
    d.gps_lon = first_f64(obj, &["GPSLongitude"]);
    d.flash = first_string(obj, &["Flash"]);
    d.white_balance = first_string(obj, &["WhiteBalance"]);
    d.metering_mode = first_string(obj, &["MeteringMode"]);
    d.exposure_bias = first_string(obj, &["ExposureCompensation"]).map(format_ev);

    has_display_exif(&d).then_some(d)
}

/// 从图像文件中提取EXIF元数据
pub fn extract_exif(path: &std::path::Path) -> (ExifData, i64) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (ExifData::default(), 0),
    };

    let exif = match exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut std::io::BufReader::new(file))
    {
        Ok(e) => e,
        Err(e) => match e.distill_partial_result(|_warnings| {}) {
            Ok(partial) => partial,
            Err(_) => return (ExifData::default(), 0),
        },
    };

    let get = |tag| exif.get_field(tag, exif::In::PRIMARY);
    let get_any = |tag| get(tag).or_else(|| exif.fields().find(|f| f.tag == tag));
    // 移除null字节和周围的引号/空格
    let clean = |s: String| -> String {
        s.chars()
            .filter(|c| !c.is_control())
            .collect::<String>()
            .trim_matches(|c: char| c == '"' || c == ' ' || c == ',')
            .to_string()
    };
    let get_str = |tag| get_any(tag).map(|f| clean(f.display_value().to_string()));
    let mut d = ExifData::default();

    d.date_taken = get_str(exif::Tag::DateTimeOriginal).or_else(|| get_str(exif::Tag::DateTime));
    d.make = get_str(exif::Tag::Make);
    d.model = get_str(exif::Tag::Model);
    d.software = get_str(exif::Tag::Software);
    d.lens_model = get_str(exif::Tag::LensModel).or_else(|| get_str(exif::Tag::LensSpecification));
    d.iso = get_str(exif::Tag::PhotographicSensitivity);

    // 曝光时间 → "1/250s" or "2s"
    if let Some(f) = get_any(exif::Tag::ExposureTime) {
        if let exif::Value::Rational(ref v) = f.value {
            if let Some(r) = v.first() {
                let val = rational_to_f64(r);
                d.exposure_time = Some(if val >= 1.0 {
                    format!("{:.1}s", val)
                } else {
                    format!("1/{}s", (1.0 / val).round() as u32)
                });
            }
        }
    }

    // f 值
    if let Some(f) = get_any(exif::Tag::FNumber) {
        if let exif::Value::Rational(ref v) = f.value {
            if let Some(r) = v.first() {
                d.f_number = Some(format!("f/{:.1}", rational_to_f64(r)));
            }
        }
    }

    // 焦距
    if let Some(f) = get_any(exif::Tag::FocalLength) {
        if let exif::Value::Rational(ref v) = f.value {
            if let Some(r) = v.first() {
                d.focal_length = Some(format!("{:.1} mm", rational_to_f64(r)));
            }
        }
    }

    d.focal_length_35mm =
        get_any(exif::Tag::FocalLengthIn35mmFilm).map(|f| format!("{} mm", f.display_value()));

    // 图像尺寸
    fn read_u32(f: &exif::Field) -> Option<u32> {
        match &f.value {
            exif::Value::Long(v) => v.first().copied(),
            exif::Value::Short(v) => v.first().map(|&x| x as u32),
            _ => None,
        }
    }
    d.image_width = get_any(exif::Tag::PixelXDimension).and_then(read_u32);
    d.image_height = get_any(exif::Tag::PixelYDimension).and_then(read_u32);

    // GPS
    d.gps_lat = get_any(exif::Tag::GPSLatitude)
        .and_then(|f| gps_coord(f, get_any(exif::Tag::GPSLatitudeRef)));
    d.gps_lon = get_any(exif::Tag::GPSLongitude)
        .and_then(|f| gps_coord(f, get_any(exif::Tag::GPSLongitudeRef)));

    // 闪光灯
    d.flash = get_str(exif::Tag::Flash);

    // 白平衡
    d.white_balance =
        get_any(exif::Tag::WhiteBalance).map(|f| match f.display_value().to_string().trim() {
            "0" => "Auto".into(),
            "1" => "Manual".into(),
            s => s.to_string(),
        });

    // 曝光补偿
    if let Some(f) = get_any(exif::Tag::ExposureBiasValue) {
        if let exif::Value::SRational(ref v) = f.value {
            if let Some(r) = v.first() {
                let val = r.num as f64 / r.denom as f64;
                d.exposure_bias = Some(format!("{:+.1} EV", val));
            }
        }
    }

    // 测光方式
    d.metering_mode = get_str(exif::Tag::MeteringMode);

    if !has_display_exif(&d) {
        if let Some(fallback) = extract_exif_with_exiftool(path) {
            let sort_key = date_to_sort_key(fallback.date_taken.as_deref());
            return (fallback, sort_key);
        }
    }

    // 排序用的时间戳
    let sort_key = date_to_sort_key(d.date_taken.as_deref());

    (d, sort_key)
}

/// 将日期字符串 "2023:07:14 15:30:22" 转换为排序用的i64: 20230714153022
pub fn date_to_sort_key(s: Option<&str>) -> i64 {
    let s = match s {
        Some(s) => s.trim_matches('"'),
        None => return 0,
    };
    s.chars()
        .filter(|c| c.is_ascii_digit())
        .take(14)
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}
