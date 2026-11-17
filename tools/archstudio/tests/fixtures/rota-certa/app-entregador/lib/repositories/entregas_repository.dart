import '../data/api/api_client.dart';
import '../data/db/banco_local.dart';
import '../data/sync/sincronizador.dart';
import '../models/entrega.dart';

class EntregasRepository {
  final _api = ApiClient();
  final _banco = BancoLocal.instancia;

  Future<List<Entrega>> doDia() async {
    final entregas = await _api.entregasDoDia();
    await _banco.guardar(entregas);
    return entregas;
  }

  Future<void> concluir(Entrega entrega, List<int> foto) => Sincronizador.instancia.enfileirar(entrega, foto);
}
