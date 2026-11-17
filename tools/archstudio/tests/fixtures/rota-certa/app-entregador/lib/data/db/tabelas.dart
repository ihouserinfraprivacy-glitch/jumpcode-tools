import 'package:drift/drift.dart';

class Tabelas extends Table {
  TextColumn get id => text()();
  TextColumn get endereco => text()();
  BoolColumn get pendente => boolean()();
}
