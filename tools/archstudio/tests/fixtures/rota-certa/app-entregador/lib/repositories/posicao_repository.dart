import '../data/api/api_client.dart';
import '../data/gps/localizacao.dart';

class PosicaoRepository {
  final _api = ApiClient();

  void acompanhar() {
    Localizacao.posicoes().listen((posicao) => _api.post('/veiculos/posicao', posicao));
  }
}
