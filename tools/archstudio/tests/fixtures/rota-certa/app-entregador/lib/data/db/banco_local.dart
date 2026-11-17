import 'package:drift/drift.dart';

import 'tabelas.dart';
import '../../models/entrega.dart';

class BancoLocal {
  static final instancia = BancoLocal();
  final tabelas = Tabelas();

  Future<void> guardar(List<Entrega> entregas) async {}
}
