import { describe, expect, it } from 'vitest';
import { folderSpot, formatSpot, gpsFromSpotExif, parseCoordinate, signedLatLon, spotKey } from './spot';
import type { ExifData, Spot } from '../types';

const emptyExif: ExifData = {
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
};

const exif = (overrides: Partial<ExifData>): ExifData => ({ ...emptyExif, ...overrides });

const spot = (overrides: Partial<Spot>): Spot => ({ name: '01 跑道北端', lat: 22.99, lon: 113.37, ...overrides });

describe('spotKey', () => {
  it('normalises the root and stray slashes to the backend key', () => {
    expect(spotKey(undefined)).toBe('');
    expect(spotKey('')).toBe('');
    expect(spotKey('/南航机/')).toBe('南航机');
    expect(spotKey(' 2024/大阪 ')).toBe('2024/大阪');
  });

  it('looks the archive up by that key', () => {
    const archive = { '南航机': spot({}) };
    expect(folderSpot(archive, '/南航机')?.name).toBe('01 跑道北端');
    expect(folderSpot(archive, '别的文件夹')).toBeNull();
  });
});

describe('parseCoordinate', () => {
  it('accepts plain decimals and signed ones', () => {
    expect(parseCoordinate('22.9912', 'lat')).toBeCloseTo(22.9912, 6);
    expect(parseCoordinate(' -33.9461 ', 'lat')).toBeCloseTo(-33.9461, 6);
  });

  it('turns a hemisphere letter into the sign', () => {
    expect(parseCoordinate('33.9461S', 'lat')).toBeCloseTo(-33.9461, 6);
    expect(parseCoordinate('N 33.9461', 'lat')).toBeCloseTo(33.9461, 6);
    expect(parseCoordinate('118.4W', 'lon')).toBeCloseTo(-118.4, 6);
    expect(parseCoordinate('151.17E', 'lon')).toBeCloseTo(151.17, 6);
  });

  it('rejects junk, the other axis letter and out-of-range values', () => {
    expect(parseCoordinate('', 'lat')).toBeNull();
    expect(parseCoordinate('abc', 'lat')).toBeNull();
    expect(parseCoordinate('12.3', 'lat')).toBe(12.3);
    expect(parseCoordinate('91', 'lat')).toBeNull();
    expect(parseCoordinate('181', 'lon')).toBeNull();
    expect(parseCoordinate('33E', 'lat')).toBeNull();
    expect(parseCoordinate('118N', 'lon')).toBeNull();
  });
});

describe('gpsFromSpotExif', () => {
  it('copies only the four GPS fields', () => {
    const patch = gpsFromSpotExif(
      exif({ gps_lat: 22.99, gps_lat_ref: 'N', gps_lon: 113.37, gps_lon_ref: 'E', make: 'Canon' }),
    );
    expect(patch).toEqual({ gps_lat: 22.99, gps_lat_ref: 'N', gps_lon: 113.37, gps_lon_ref: 'E' });
    expect((patch as ExifData).make).toBeUndefined();
  });
});

describe('signedLatLon', () => {
  it('folds the reference letters back into the sign', () => {
    expect(signedLatLon(exif({ gps_lat: 33.9, gps_lat_ref: 'S', gps_lon: 151.1, gps_lon_ref: 'E' }))).toEqual({
      lat: -33.9,
      lon: 151.1,
    });
    expect(signedLatLon(exif({ gps_lat: 33.9, gps_lat_ref: 'N', gps_lon: 118.4, gps_lon_ref: 'W' }))).toEqual({
      lat: 33.9,
      lon: -118.4,
    });
    expect(signedLatLon(exif({}))).toEqual({ lat: null, lon: null });
  });
});

describe('formatSpot', () => {
  it('shows name, hemispheres and the note when there is one', () => {
    expect(formatSpot(spot({ lat: -33.9461, lon: 151.1772, note: '' }))).toBe(
      '01 跑道北端 · 33.9461°S 151.1772°E',
    );
    expect(formatSpot(spot({ note: '下午顺光' }))).toBe('01 跑道北端 · 22.9900°N 113.3700°E · 下午顺光');
  });
});
