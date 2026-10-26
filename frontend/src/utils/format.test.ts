import { describe, expect, it } from 'vitest';
import type { ExifData } from '../types';
import { fmtDate, fmtMegapixels, fmtSize, hasAnyExif } from './format';

const EMPTY = {
  date_taken: null,
  make: null,
  model: null,
  lens_model: null,
  software: null,
  iso: null,
  exposure_time: null,
  f_number: null,
  focal_length: null,
  focal_length_35mm: null,
  image_width: null,
  image_height: null,
  gps_altitude: null,
  gps_altitude_ref: null,
  gps_lat: null,
  gps_lat_ref: null,
  gps_lon: null,
  gps_lon_ref: null,
  gps_date_stamp: null,
  gps_time_stamp: null,
  gps_version_id: null,
  gps_map_datum: null,
  flash: null,
  white_balance: null,
  metering_mode: null,
  exposure_bias: null,
} satisfies ExifData;

function exif(over: Partial<ExifData>): ExifData {
  return { ...EMPTY, ...over };
}

describe('fmtSize', () => {
  it('switches unit at each binary boundary', () => {
    expect(fmtSize(0)).toBe('0 B');
    expect(fmtSize(1023)).toBe('1023 B');
    expect(fmtSize(1024)).toBe('1.0 KB');
    expect(fmtSize(1048575)).toBe('1024.0 KB');
    expect(fmtSize(1048576)).toBe('1.00 MB');
    expect(fmtSize(25165824)).toBe('24.00 MB');
  });
});

describe('fmtMegapixels', () => {
  it('returns null unless both edges are known', () => {
    expect(fmtMegapixels(undefined, 4000)).toBeNull();
    expect(fmtMegapixels(4000, 0)).toBeNull();
  });

  it('keeps three significant digits across the magnitude thresholds', () => {
    expect(fmtMegapixels(900, 900)).toBe('0.810 MP');
    expect(fmtMegapixels(1000, 1000)).toBe('1.00 MP');
    expect(fmtMegapixels(1504, 1000)).toBe('1.50 MP');
    expect(fmtMegapixels(1500, 1000)).toBe('1.50 MP');
    expect(fmtMegapixels(4000, 3000)).toBe('12.0 MP');
    expect(fmtMegapixels(8256, 6160)).toBe('50.9 MP');
  });
});

describe('fmtDate', () => {
  it('turns an EXIF stamp into a readable local string', () => {
    expect(fmtDate('2024:01:02 03:04:05')).toBe('2024-01-02 03:04');
  });

  it('strips the quotes exiftool sometimes wraps around values', () => {
    expect(fmtDate('"2024:01:02 03:04:05"')).toBe('2024-01-02 03:04');
  });

  it('leaves anything else untouched and shows a dash for missing values', () => {
    expect(fmtDate('2024-01-02T03:04:05Z')).toBe('2024-01-02T03:04:05Z');
    expect(fmtDate('')).toBe('—');
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
  });
});

describe('hasAnyExif', () => {
  it('is false for a missing or fully empty block', () => {
    expect(hasAnyExif(null)).toBe(false);
    expect(hasAnyExif(undefined)).toBe(false);
    expect(hasAnyExif(EMPTY)).toBe(false);
  });

  it('is true for a single populated shooting field', () => {
    expect(hasAnyExif(exif({ date_taken: '2024:01:02 03:04:05' }))).toBe(true);
    expect(hasAnyExif(exif({ exposure_bias: '0' }))).toBe(true);
    expect(hasAnyExif(exif({ gps_lat: 22.5 }))).toBe(true);
  });

  // 只有零值的字段在 hasAnyExif 里等同没填，这类照片仍按“无 EXIF”统计。
  it('treats a lone zero as no metadata', () => {
    expect(hasAnyExif(exif({ gps_lat: 0 }))).toBe(false);
  });

  // 像素尺寸来自文件本身而不是 EXIF 段，只有宽高不算“这张照片带 EXIF”。
  it('ignores image dimensions on their own', () => {
    expect(hasAnyExif(exif({ image_width: 8256, image_height: 6160 }))).toBe(false);
  });
});
