import 'package:dio/dio.dart';

import 'endpoints.dart';
import '../../models/entrega.dart';

class ApiClient {
  static const baseUrl = String.fromEnvironment('API_URL', defaultValue: 'https://api.rotacerta.com.br');
  final _dio = Dio(BaseOptions(baseUrl: baseUrl));

  Future<void> post(String caminho, Object corpo) => _dio.post(caminho, data: corpo);

  Future<List<Entrega>> entregasDoDia() async {
    final resposta = await _dio.get(Endpoints.entregasDoDia);
    return (resposta.data as List).map((item) => Entrega.deJson(item)).toList();
  }
}
