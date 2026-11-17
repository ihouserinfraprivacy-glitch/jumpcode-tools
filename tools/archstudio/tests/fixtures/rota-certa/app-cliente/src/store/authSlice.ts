import { createSlice } from '@reduxjs/toolkit';
import { entrar } from '../api/auth';

const authSlice = createSlice({ name: 'auth', initialState: { token: '' }, reducers: {} });
export { entrar };
export default authSlice.reducer;
