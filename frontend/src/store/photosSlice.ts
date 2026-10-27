import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ExifData, Photo, Spot, StagedOp } from '../types';
import { subpath } from '../utils/paths';

interface PhotosState {
  photos: Photo[];
  stagedOps: StagedOp[];
  selected: string[];
  anchor: string | null;
  /** 文件夹（'' 表示库根）→ 手写拍摄点档案 */
  spots: Record<string, Spot>;
}

const initialState: PhotosState = {
  photos: [],
  stagedOps: [],
  selected: [],
  anchor: null,
  spots: {},
};

const photosSlice = createSlice({
  name: 'photos',
  initialState,
  reducers: {
    setPhotos: (state, action: PayloadAction<Photo[]>) => {
      state.photos = action.payload;
      const valid = new Set(action.payload.map((photo) => subpath(photo)));
      state.selected = state.selected.filter((sp) => valid.has(sp));
      if (state.anchor && !valid.has(state.anchor)) state.anchor = null;
    },
    setStagedOps: (state, action: PayloadAction<StagedOp[]>) => {
      state.stagedOps = action.payload;
    },
    setSelection: (
      state,
      action: PayloadAction<{ selected: string[]; anchor: string | null }>,
    ) => {
      state.selected = action.payload.selected;
      state.anchor = action.payload.anchor;
    },
    toggleSelected: (state, action: PayloadAction<string>) => {
      const sp = action.payload;
      state.selected = state.selected.includes(sp)
        ? state.selected.filter((item) => item !== sp)
        : [...state.selected, sp];
      state.anchor = sp;
    },
    clearSelection: (state) => {
      state.selected = [];
      state.anchor = null;
    },
    setLens: (state, action: PayloadAction<{ subpath: string; lens: string }>) => {
      const photo = state.photos.find((item) => subpath(item) === action.payload.subpath);
      if (photo) photo.exif.lens_model = action.payload.lens;
    },
    // 机身文字识别完立刻回写：卡片徽章和信息面板不必等下一次列表请求
    setRegs: (
      state,
      action: PayloadAction<{ subpath: string; regs: string[]; source: 'name' | 'ocr' }>,
    ) => {
      const photo = state.photos.find((item) => subpath(item) === action.payload.subpath);
      if (!photo) return;
      photo.regs = action.payload.regs;
      photo.reg_source = action.payload.source;
    },
    setSpots: (state, action: PayloadAction<Record<string, Spot>>) => {
      state.spots = action.payload;
    },
    // 存/删档案后先改内存：档案列表和「这一文件夹有没有坐标」立刻对上
    putSpot: (state, action: PayloadAction<{ folder: string; spot: Spot }>) => {
      state.spots[action.payload.folder] = action.payload.spot;
    },
    dropSpot: (state, action: PayloadAction<string>) => {
      delete state.spots[action.payload];
    },
    // 拍摄点补给单张照片后，只覆盖 GPS 那几格，别的 EXIF 保持原样
    patchPhotoExif: (state, action: PayloadAction<{ subpath: string; patch: Partial<ExifData> }>) => {
      const photo = state.photos.find((item) => subpath(item) === action.payload.subpath);
      if (!photo) return;
      Object.assign(photo.exif, action.payload.patch);
    },
  },
});

export const {
  setPhotos,
  setStagedOps,
  setSelection,
  toggleSelected,
  clearSelection,
  setLens,
  setRegs,
  setSpots,
  putSpot,
  dropSpot,
  patchPhotoExif,
} = photosSlice.actions;

export default photosSlice.reducer;
