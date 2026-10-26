import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Photo, StagedOp } from '../types';
import { subpath } from '../utils/paths';

interface PhotosState {
  photos: Photo[];
  stagedOps: StagedOp[];
  selected: string[];
  anchor: string | null;
}

const initialState: PhotosState = {
  photos: [],
  stagedOps: [],
  selected: [],
  anchor: null,
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
  },
});

export const {
  setPhotos,
  setStagedOps,
  setSelection,
  toggleSelected,
  clearSelection,
  setLens,
} = photosSlice.actions;

export default photosSlice.reducer;
