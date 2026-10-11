interface Worker { String run(String value); }
class StringWorker implements Worker { public String run(String value) { return value; } }
class Work { static String dispatch(Worker worker) { return worker.run("x"); } static int dispatch(int value) { return value; } }
