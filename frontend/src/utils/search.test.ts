import { describe, expect, it } from 'vitest';
import { filterPhotos, photoMatchesTerm } from './search';
import type { Photo } from '../types';

const emptyExif: Photo['exif'] = {
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
  flash: null,
  white_balance: null,
  metering_mode: null,
  exposure_bias: null,
  image_width: null,
  image_height: null,
  gps_lat: null,
  gps_lat_ref: null,
  gps_lon: null,
  gps_lon_ref: null,
  gps_altitude: null,
  gps_altitude_ref: null,
  gps_map_datum: null,
  gps_version_id: null,
  gps_date_stamp: null,
  gps_time_stamp: null,
};

function photo(overrides: Partial<Photo>): Photo {
  return {
    filename: 'IMG_0001.JPG',
    folder: '',
    size: 1024,
    mtime: 0,
    exif: emptyExif,
    date_sort_key: 0,
    ...overrides,
  };
}

describe('photoMatchesTerm', () => {
  it('matches filename, folder and full path as before', () => {
    const shot = photo({ filename: 'B-3207_takeoff.jpg', folder: '南航机' });
    expect(photoMatchesTerm(shot, 'takeoff')).toBe(true);
    expect(photoMatchesTerm(shot, '南航')).toBe(true);
    expect(photoMatchesTerm(shot, '南航机/B-3207')).toBe(true);
    expect(photoMatchesTerm(shot, 'jetta')).toBe(false);
  });

  it('treats an empty term as a match', () => {
    expect(photoMatchesTerm(photo({}), '   ')).toBe(true);
  });

  it('finds a registration regardless of how the separators were typed', () => {
    const shot = photo({ filename: 'IMG_9001.jpg', regs: ['B-3207'], reg_source: 'name' });
    expect(photoMatchesTerm(shot, 'b3207')).toBe(true);
    expect(photoMatchesTerm(shot, 'B-3207')).toBe(true);
    expect(photoMatchesTerm(shot, '3207')).toBe(true);
    expect(photoMatchesTerm(shot, 'b3208')).toBe(false);
  });

  it('matches either registration when a frame holds two aircraft', () => {
    const shot = photo({ filename: 'pair.jpg', regs: ['VH-OQG', '9M-MRK'], reg_source: 'ocr' });
    expect(photoMatchesTerm(shot, 'mrk')).toBe(true);
    expect(photoMatchesTerm(shot, 'oqg')).toBe(true);
    expect(photoMatchesTerm(shot, 'rrc')).toBe(false);
  });
});

describe('filterPhotos', () => {
  it('returns the list untouched for an empty term', () => {
    const list = [photo({}), photo({ filename: 'other.jpg' })];
    expect(filterPhotos(list, '')).toBe(list);
  });

  it('keeps only the hits', () => {
    const list = [
      photo({ filename: 'a.jpg', regs: ['B-3207'] }),
      photo({ filename: 'b.jpg', regs: ['VH-OQG'] }),
    ];
    expect(filterPhotos(list, '3207')).toEqual([list[0]]);
  });
});
