import 'package:connectivity_plus/connectivity_plus.dart';

import '../api/api_client.dart';
import '../db/banco_local.dart';
import '../../models/entrega.dart';

class Sincronizador {
  static final instancia = Sincronizador();
  final _api = ApiClient();
  final _banco = BancoLocal.instancia;

  Future<void> enfileirar(Entrega entrega, List<int> foto) async {
    final conectado = await Connectivity().checkConnectivity();
    if (conectado.isEmpty) {
      await _banco.guardar([entrega]);
      return;
    }
    await _api.post('/entregas/comprovante', {'id': entrega.id, 'foto': foto});
  }
}
