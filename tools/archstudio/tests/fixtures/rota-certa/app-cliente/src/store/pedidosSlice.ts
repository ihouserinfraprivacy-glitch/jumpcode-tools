import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { enviarPedido } from '../api/pedidos';

export const criarPedido = createAsyncThunk('pedidos/criar', enviarPedido);

const pedidosSlice = createSlice({
  name: 'pedidos',
  initialState: { lista: [] as { id: string; status: string }[] },
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(criarPedido.fulfilled, (estado, acao) => { estado.lista.push(acao.payload); });
  },
});

export default pedidosSlice.reducer;
